/**
 * Color-palette harness adapter.
 *
 * Runs the Color palettes suite with nothing but the tool: the cases ship in
 * `public-suites/color-palette/cases` and this module sends each one to the
 * server's palette endpoint and scores the answer (`palette_metrics.ts`). No
 * additional checkout is involved, so a run
 * needs only the tool and a Tableau Server connection.
 *
 * One case is one request: the utterance and the palette type it asks for
 * (regular, sequential or diverging) go to
 * `POST <server>/content-exploration/analytics-assistant/color-palettes/generate`
 * with the run's Tableau session, and the server answers `{"colors": [...]}`
 * from the site's configured model. The request policy is the one the other
 * server-backed suites use: a two-minute limit per request
 * (`TABLEAU_AI_EVAL_REQUEST_TIMEOUT` overrides), three attempts with backoff on 429 /
 * 5xx / network failures, and one re-sign-in on a 401. 501 (the feature is off
 * on the site) is said plainly and not retried.
 *
 * The judge-scored part of the palette rubric (valid / relevance / design) is
 * attached by the orchestrator from the row this adapter emits
 * (`actual.colorPalette` + `actual.paletteType`; see `palette_judge.ts`).
 *
 * Implementation notes:
 *   - The adapter is a process-wide singleton, so the run's job id is read from
 *     `config.job_id` (stamped by the orchestrator's `shareRunSession` before
 *     `session()`), not stored on the instance.
 *   - `fetchImpl`, `sleep` and `sessionFor` are injectable for offline tests.
 *   - Without a `test_path`, the bundled suite is found the way
 *     `public_content.publicSuitesRoot()` finds `public-suites/`
 *     (`TABLEAU_AI_EVAL_PUBLIC_SUITES` → the copy embedded in the compiled binary → the repo root).
 *     `core` cannot import the server package, so the lookup is repeated here.
 */

import { join } from "node:path";
import { contentIsDir, contentReaddir, contentReadText } from "@tableau-ai-eval/core";
import type {
  AdapterSession,
  EmitCase,
  EvalAdapter,
  MetricEntry,
  RowError,
  RowPayload,
  RunConfig,
  ShouldStop,
  SuitePlan,
  TableauSession,
} from "@tableau-ai-eval/core";
import {
  register,
  resolveMaxConcurrency,
  resolveRequestsPerMinute,
  sessionFromRunConfig,
  sharedSession,
  tlsInit,
} from "@tableau-ai-eval/core";
import { RateLimiter, requestTimeoutS } from "../harness/nlq_runner.ts";
import { computePaletteMetrics, STAGE } from "../metrics/palette_metrics.ts";
import { bundledDir } from "../public_suites.ts";

/**
 * The runner name palette runs have always been recorded under; the results
 * page and the run history map it to the Color palettes capability.
 */
export const RUNNER_NAME = "color-palettes-server";
export const SUITE_SUBDIR = join("color-palette", "cases");

const CES_PREFIX = "/content-exploration";
export const ENDPOINT = `${CES_PREFIX}/analytics-assistant/color-palettes/generate`;
const HEADERS: Record<string, string> = {
  Accept: "application/vnd.analytics-assistant.color-palettes.v1.0+json",
  "Content-Type": "application/json",
};

/** Requests to the server per 10 seconds unless the run names its own rate. */
const DEFAULT_RATE: [number, number] = [2, 10];
export const MAX_ATTEMPTS = 3;
const BODY_PREVIEW = 300;

/** One loaded palette case. */
export interface PaletteCase {
  case_id: string;
  utterance: string;
  palette_type: string | null;
  expected: Record<string, unknown>;
  turn: number;
  info: Record<string, unknown>;
}

interface PaletteOpaque {
  cases: PaletteCase[];
}

// ---------------------------------------------------------------------------
// Where the cases are
// ---------------------------------------------------------------------------

const isDir = contentIsDir;

/** The Color palettes cases that ship with the tool, or null. */
export function bundledSuiteDir(): string | null {
  return bundledDir(SUITE_SUBDIR);
}

function suiteDir(config: RunConfig): string {
  const explicit = (config.test_path as string) || (config.test_cases_dir as string) || "";
  const path = explicit ? explicit : bundledSuiteDir();
  if (!path || !isDir(path)) {
    throw new Error(
      "Color palettes test cases not found" +
        (explicit
          ? ` at ${explicit}`
          : ": the tool's public-suites/color-palette folder is missing"),
    );
  }
  return path;
}

function jsonFilesSorted(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = contentReaddir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      if (isDir(full)) walk(full);
      else if (name.endsWith(".json")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const asDict = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Every runnable case under `dir`, in file-name order. A file is
 * `{"id", "runner", "info", "inputs": [{"utterance", "arguments":
 * {"palette_type"}, "expected": {"colorPalette": [...]}}]}`; each input is one
 * case. Files that cannot be read, or that belong to another runner, are
 * skipped.
 */
export function loadCases(dir: string, log?: (msg: string) => void): PaletteCase[] {
  const cases: PaletteCase[] = [];
  for (const path of jsonFilesSorted(dir)) {
    let doc: unknown;
    try {
      doc = JSON.parse(contentReadText(path));
    } catch (exc) {
      log?.(`Skipping ${path}: not readable as JSON (${exc instanceof Error ? exc.message : exc})`);
      continue;
    }
    const d = asDict(doc);
    const inputs = d.inputs;
    if (!Array.isArray(inputs) || !inputs.length || !d.id) {
      log?.(`Skipping ${path}: no id or no inputs`);
      continue;
    }
    if (d.runner !== undefined && d.runner !== null && d.runner !== RUNNER_NAME) continue;
    inputs.forEach((raw, i) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const input = raw as Record<string, unknown>;
      const args = asDict(input.arguments);
      const pt = args.palette_type;
      cases.push({
        case_id: inputs.length === 1 ? String(d.id) : `${d.id}:${i}`,
        utterance: (input.utterance as string) || "",
        palette_type: typeof pt === "string" ? pt : null,
        expected: asDict(input.expected),
        turn: i,
        info: asDict(d.info),
      });
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * The palette endpoint on the run's server. The stored connection carries the
 * content-exploration root (`<server>/content-exploration`); a development
 * service started on its own has no such suffix.
 */
export function requestUrl(config: RunConfig): string {
  let base = String(config.ces_url ?? "").trim().replace(/\/+$/, "");
  if (base.endsWith(CES_PREFIX)) base = base.slice(0, -CES_PREFIX.length);
  base = base || String(config.tableau_server ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "The Color palettes suite needs a Tableau Server connection " +
        "(tableau_server): save one in Settings first",
    );
  }
  return base + ENDPOINT;
}

function verifyTls(config: RunConfig, url: string): boolean {
  const raw = config.verify_tls;
  if (raw !== undefined && raw !== null) return Boolean(raw);
  const host = new URL(url).hostname;
  return host !== "localhost" && host !== "127.0.0.1";
}

/**
 * The run's Tableau session: the one the orchestrator already opened for this
 * run when there is one (a Personal Access Token supports one live session, so
 * a second sign-in would end the first), else a session of the adapter's own,
 * else null (a development service that needs no sign-in).
 */
export function sessionFor(config: RunConfig, jobId: string | null | undefined): TableauSession | null {
  return sharedSession(jobId) ?? sessionFromRunConfig(config);
}

/** Retry backoff: 5 s, 10 s, … capped at 30 s, plus up to 2 s of jitter. */
function backoffMs(attempt: number): number {
  return (Math.min(30, 5 * 2 ** (attempt - 1)) + Math.random() * 2) * 1000;
}

/** Python `json.dumps` spacing, for the "had no colors" preview. */
function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(v);
}

type FetchLike = (url: string, init: RequestInit & { tls?: unknown }) => Promise<Response>;

export interface PostDeps {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  limiter: RateLimiter;
  tls: { tls?: unknown };
}

/**
 * One palette request with bounded retries: [status, body, seconds]. `status`
 * is null when no answer arrived; `body` is the parsed JSON of a 200 and
 * otherwise a short text saying what went wrong. 429, 5xx and network failures
 * are tried up to three times with backoff; 501 is not (the feature is off, and
 * asking again changes nothing). A 401 re-signs in once and repeats the
 * request at once.
 */
export async function postPalette(
  url: string,
  payload: Record<string, unknown>,
  session: TableauSession | null,
  deps: PostDeps,
  requestHeaders: Record<string, string> = HEADERS,
  signal?: AbortSignal,
): Promise<[number | null, unknown, number | null]> {
  const headers: Record<string, string> = { ...requestHeaders };
  if (session) {
    headers["X-Tableau-Auth"] = await session.getToken();
  } else {
    // A development service without sign-in takes the caller's identity from
    // the address.
    url = `${url}?overwrite=true&user=1&siteLuid=2&admin`;
  }

  const timeoutS = requestTimeoutS();
  let attempt = 0;
  let reauthed = false;
  while (true) {
    attempt += 1;
    await deps.limiter.acquire(signal);
    const started = performance.now();
    let status: number | null = null;
    let resp: Response | null = null;
    let body: unknown = null;
    try {
      resp = await deps.fetchImpl(url, {
        method: "POST",
        headers: { ...headers },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutS * 1000)]) : AbortSignal.timeout(timeoutS * 1000),
        ...deps.tls,
      });
      status = resp.status;
    } catch (exc) {
      signal?.throwIfAborted();
      const name = (exc as { name?: unknown } | null)?.name;
      body =
        name === "TimeoutError"
          ? `network error: no answer from the server within ${timeoutS} s`
          : `network error: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
    const seconds = (performance.now() - started) / 1000;

    if (status === 200 && resp) {
      const text = await resp.text().catch(() => "");
      try {
        return [status, JSON.parse(text), seconds];
      } catch {
        return [status, text.slice(0, BODY_PREVIEW), seconds];
      }
    }
    if (resp) {
      const text = (await resp.text().catch(() => "")).trim().slice(0, BODY_PREVIEW);
      body = text || null;
    }

    if (status === 401 && session && !reauthed) {
      reauthed = true;
      try {
        headers["X-Tableau-Auth"] = await session.handle401(headers["X-Tableau-Auth"]);
        continue;
      } catch (exc) {
        return [status, `re-signin after 401 failed: ${exc instanceof Error ? exc.message : exc}`, seconds];
      }
    }

    const transient = status === null || status === 429 || (status >= 500 && status !== 501);
    if (!transient || attempt >= MAX_ATTEMPTS) return [status, body, seconds];
    await deps.sleep(backoffMs(attempt));
  }
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

const runError = (description: string): RowError => ({
  phase: "RUN_TEST",
  description,
  warning: false,
});

const pyBody = (b: unknown): string => (b === null || b === undefined ? "None" : String(b));

/** Ask the server for the case's palette and score it; the row payload. */
async function runCase(
  url: string,
  c: PaletteCase,
  session: TableauSession | null,
  deps: PostDeps,
  log?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<RowPayload> {
  const row: RowPayload = {
    test_case_id: c.case_id,
    runner: RUNNER_NAME,
    datasource: null,
    utterance: c.utterance,
    turn: c.turn,
    expected: c.expected,
    actual: {},
    latency: null,
    errors: [],
    metrics: {},
    debug_info: {},
    info: c.info,
  };
  const payload = { utterance: { content: c.utterance }, paletteType: c.palette_type };
  let status: number | null;
  let body: unknown;
  let seconds: number | null;
  try {
    [status, body, seconds] = await postPalette(url, payload, session, deps, HEADERS, signal);
  } catch (exc) {
    log?.(`Palette request failed for case ${c.case_id}: ${exc}`);
    const msg = exc instanceof Error ? exc.message || exc.constructor.name : String(exc);
    row.errors.push(runError(msg));
    return row;
  }

  if (status === 501) {
    row.errors.push(
      runError(
        "Color palette generation is not enabled for this site on this " +
          `server (501): ${pyBody(body)}`,
      ),
    );
    return row;
  }
  if (status === null) {
    row.errors.push(
      runError(
        `Tableau Server did not answer the palette request (${pyBody(body)}). Check that ` +
          "this computer still reaches the server, then resume the evaluation.",
      ),
    );
    return row;
  }
  if (status === 401) {
    row.errors.push(
      runError(
        "Tableau Server refused the palette request (HTTP 401): the session is " +
          "gone or the token has expired. Test the connection in Evaluation Setup, " +
          `step 1, then resume the evaluation. Server said: ${pyBody(body)}`,
      ),
    );
    return row;
  }
  if (status === 404) {
    row.errors.push(
      runError(
        "Tableau Server has no palette endpoint (HTTP 404): its release is " +
          "earlier than the first one with color palette suggestions. Upgrade the " +
          "server, then test the connection again.",
      ),
    );
    return row;
  }
  if (status !== 200) {
    row.errors.push(
      runError(
        `Tableau Server answered the palette request with HTTP ${status}: ${pyBody(body)}.` +
          (status >= 500
            ? " A 5xx is the site's AI model or its gateway, not the connection: test it " +
              "in Site Settings > AI in Tableau, then resume the evaluation."
            : ""),
      ),
    );
    return row;
  }
  const colors = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).colors
    : undefined;
  if (!Array.isArray(colors)) {
    const preview = typeof body === "string" ? body : pyDumps(body).slice(0, BODY_PREVIEW);
    row.errors.push(runError(`The server's answer had no colors: ${preview}`));
    return row;
  }

  row.latency = seconds;
  row.actual = { colorPalette: colors };
  if (c.palette_type) row.actual.paletteType = c.palette_type;
  if ("colorPalette" in c.expected) {
    let entries: MetricEntry[];
    let errors: RowError[];
    try {
      [entries, errors] = computePaletteMetrics(c.palette_type, c.expected.colorPalette, colors);
    } catch (exc) {
      // The answer exists; only scoring failed.
      const name = exc instanceof Error ? exc.constructor.name : "Error";
      const msg = exc instanceof Error ? exc.message : String(exc);
      entries = [];
      errors = [
        { phase: "EVALUATE_RESULT", description: `Scoring failed: ${name}: ${msg}`, warning: false },
      ];
    }
    if (entries.length) row.metrics[STAGE] = entries;
    row.errors.push(...errors);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface PaletteAdapterOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  sessionFor?: (config: RunConfig, jobId: string | null | undefined) => TableauSession | null;
  log?: (msg: string) => void;
}

export class PaletteAdapter implements EvalAdapter {
  readonly id = "palettes";
  private readonly _fetch: FetchLike;
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _sessionFor: (config: RunConfig, jobId: string | null | undefined) => TableauSession | null;
  private readonly _log?: (msg: string) => void;

  constructor(opts: PaletteAdapterOptions = {}) {
    this._fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit));
    this._sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._sessionFor = opts.sessionFor ?? sessionFor;
    this._log = opts.log;
  }

  session(config: RunConfig, _jobId: string): AdapterSession {
    // Nothing global to set up (no working directory, no credential files);
    // fail a run with no server to talk to before it starts.
    requestUrl(config);
    return { close() {} };
  }

  load(config: RunConfig): SuitePlan {
    const dir = suiteDir(config);
    const cases = loadCases(dir, this._log);
    if (!cases.length) throw new Error(`No runnable Color palettes cases found at ${dir}`);
    const opaque: PaletteOpaque = { cases };
    return {
      total: cases.length,
      skeletons: cases.map((c) => ({
        test_case_id: c.case_id,
        runner: RUNNER_NAME,
        datasource: null,
        utterance: c.utterance,
        expected: c.expected,
      })),
      conversation_ids: cases.map((c) => [c.case_id]),
      opaque,
    };
  }

  async execute(
    plan: SuitePlan,
    config: RunConfig,
    emitCase: EmitCase,
    shouldStop: ShouldStop,
    completedIds: Set<string>,
  ): Promise<void> {
    const url = requestUrl(config);
    const session = this._sessionFor(config, config.job_id as string | undefined);
    const rpm = resolveRequestsPerMinute(config);
    const [rate, windowS] = rpm ? [Math.max(1, rpm / 6), 10] : DEFAULT_RATE;
    const deps: PostDeps = {
      fetchImpl: this._fetch,
      sleep: this._sleep,
      limiter: new RateLimiter({ rate, windowMs: windowS * 1000 }),
      tls: tlsInit({
        verify: verifyTls(config, url),
        caBundlePath: config.ca_bundle_path as string | undefined,
      }),
    };

    // At most `max_concurrency` cases in flight, started in plan order.
    const limit = resolveMaxConcurrency(config);
    let inFlight = 0;
    const waiters: Array<() => void> = [];
    const acquire = async (): Promise<void> => {
      if (inFlight < limit) {
        inFlight += 1;
        return;
      }
      await new Promise<void>((r) => waiters.push(r));
      inFlight += 1;
    };
    const release = (): void => {
      inFlight -= 1;
      waiters.shift()?.();
    };

    const guarded = async (c: PaletteCase): Promise<void> => {
      if (completedIds.size && completedIds.has(c.case_id)) return;
      await acquire();
      try {
        // Nothing new starts once a pause or cancel is asked for; the cases
        // already in flight finish.
        if (shouldStop()) return;
        plan.case_started?.(c.case_id);
        await emitCase(await runCase(url, c, session, deps, this._log, config._run_signal as AbortSignal | undefined));
      } finally {
        release();
      }
    };

    const results = await Promise.allSettled(
      (plan.opaque as PaletteOpaque).cases.map((c) => guarded(c)),
    );
    for (const r of results) if (r.status === "rejected") throw r.reason;
  }
}

export function createPaletteAdapter(opts: PaletteAdapterOptions = {}): PaletteAdapter {
  return new PaletteAdapter(opts);
}

register(new PaletteAdapter());
