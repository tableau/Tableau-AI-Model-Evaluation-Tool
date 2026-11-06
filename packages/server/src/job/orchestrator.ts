/**
 * Evaluation-run orchestrator.
 *
 * Harness-agnostic driver for a single evaluation run, executed on the
 * in-process worker queue (`src/worker/queue.ts`). It owns run records, the
 * SSE event stream, the resume skip-list, pause/cancel control, SQLite
 * persistence, judge attachment, and the embedded CES bridge lifecycle.
 * Everything harness-specific lives behind the `EvalAdapter` contract
 * (`src/adapters/contract.ts`), resolved via `getAdapter(config)`.
 *
 * Flow per run: (optional) CES bridge → adapter session → load plan →
 * resume skip-list → start/skeletons events → adapter.execute() emitting
 * per-case results → judge attach + row event + persist + progress per case
 * → pause/cancel/finished three-way.
 *
 * ## Dependency injection
 * The database and SSE state are
 * injected via `OrchestratorDeps` so a run can be driven end-to-end into
 * an in-memory / temp SQLite with a fake harness in tests, and the CES bridge
 * / judge fetch seams are injectable too.
 *
 * ## Harness seam left unwired-fails-cleanly
 * `getAdapter(config)` lazily imports the selected adapter, which
 * self-registers with a placeholder `HarnessRunner` that throws loudly if
 * invoked (see `src/adapters/nlq.ts`). So a run whose harness is not wired
 * fails THAT run cleanly (error + done events, run marked failed) without
 * taking down the worker. Tests inject a fake adapter/harness to drive real
 * cases.
 */

import type { AiEvalDb } from "@tableau-ai-eval/core";
import type { SseState } from "@tableau-ai-eval/core";
import { RunLifecycle } from "@tableau-ai-eval/core";
import { describeSpec } from "@tableau-ai-eval/evals";
import {
  getAdapter as defaultGetAdapter,
  type EvalAdapter,
  type RowPayload,
  type RowError,
  type RunConfig,
  resolveMaxConcurrency,
} from "@tableau-ai-eval/core";
import { partsOf } from "../suites/catalog.ts";
import * as dashboardContent from "../suites/dashboard_content.ts";
import { publicSuitesRoot } from "../suites/public_content.ts";
import {
  computeJudgeMetrics,
  computePaletteJudgeMetrics,
  computeNarrativeJudgeMetrics,
  type NarrativeTruths,
  JUDGE_STAGE,
  type ComputedMetric,
  type FetchFn,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
} from "@tableau-ai-eval/core";
import { CesBridge, DEFAULT_RETRY_DELAY_MS } from "../bridge/ces.ts";
import {
  TableauAuthError,
  TableauSession,
  sessionFromRunConfig,
  shareSession,
  unshareSession,
  probeSiteModels,
} from "@tableau-ai-eval/core";

const DEBUG_INFO_MAX_BYTES = Number(
  process.env.DEBUG_INFO_MAX_BYTES ?? "8192",
);

/** Injected collaborators. Real wiring supplies db + sse; tests can fake all. */
export interface OrchestratorDeps {
  db: AiEvalDb;
  sse: SseState;
  lifecycle?: RunLifecycle;
  /** Private authority of this execution. Revoked by pause/cancel/resume. */
  executionId?: string;
  /** Adapter resolver (default: the real registry-backed `getAdapter`). */
  getAdapter?: (config: RunConfig) => Promise<EvalAdapter>;
  /** Judge fetch seam (offline tests inject). */
  judgeFetch?: FetchFn;
  /** Judge retry policy (tests inject a no-wait policy). */
  judgeRetry?: RetryPolicy;
  /** CES bridge fetch seam (offline tests inject). */
  cesFetch?: typeof fetch;
  /** CES bridge retry backoff base (ms); tests inject 0 for instant retries. */
  cesRetryDelayMs?: number;
  /** Process-local pause/cancellation handles; never persisted in run configs. */
  runControllers?: Map<string, AbortController>;
  /** Optional logger. */
  log?: (msg: string, err?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Event / state helpers — thin wrappers so a state hiccup never crashes a run.
// ---------------------------------------------------------------------------

function spub(deps: OrchestratorDeps, jobId: string, payload: Record<string, unknown>): void {
  deps.sse.appendEvent(jobId, payload);
}

function writeState(
  deps: OrchestratorDeps,
  jobId: string,
  patch: Record<string, unknown>,
): void {
  lifecycle(deps).patch(jobId, patch, deps.executionId);
}

function lifecycle(deps: OrchestratorDeps): RunLifecycle {
  return deps.lifecycle ?? new RunLifecycle(deps.db, deps.sse);
}

function authorized(deps: OrchestratorDeps, jobId: string): boolean {
  return deps.executionId === undefined || lifecycle(deps).owns(jobId, deps.executionId);
}

function getControl(deps: OrchestratorDeps, jobId: string): string | null {
  try {
    return deps.db.getJobControl(jobId);
  } catch {
    return null;
  }
}

// Statuses from which we must never downgrade back to "started"/progress.
const TERMINAL_STATUSES = new Set(["cancelled", "paused", "failed", "finished", "done"]);

/**
 * Re-read the control flag AND the current run status right before writing a
 * "started"/progress update. Returns true only if the run is still actively
 * running (no control request landed and the run is not already in a
 * terminal/paused state). This closes the TOCTOU window where a /cancel or
 * /pause landing between the initial check and the status write would be
 * overwritten back to "started".
 */
function isStillActive(deps: OrchestratorDeps, jobId: string): boolean {
  if (!authorized(deps, jobId)) return false;
  if (getControl(deps, jobId)) return false;
  try {
    const run = deps.db.getRun(jobId);
    const stateStatus = deps.db.getJobState(jobId).status;
    if (typeof stateStatus === "string" && TERMINAL_STATUSES.has(stateStatus)) return false;
    const status = run?.status;
    if (typeof status === "string" && TERMINAL_STATUSES.has(status)) return false;
  } catch {
    // If we cannot read the run status, fall back to the control check above.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Transient-failure retry pass
// ---------------------------------------------------------------------------

/**
 * A case whose only run-phase error is one of these failed for a reason that
 * has nothing to do with the model: the site's LLM gateway answered 5xx (it
 * does so intermittently, and a cold first call on a site can fail three
 * attempts in a row), or the network dropped. The runner already retries each
 * request three times over ~15s; the retry pass re-runs such cases once more
 * after the whole suite has gone through, which spaces the retry out by minutes
 * instead of seconds.
 */
const TRANSIENT_ERROR_RE =
  /Bad response \((5\d\d|None)\)|network error|gateway|timed? ?out|\(HTTP 5\d\d\)|\(HTTP 401\)|'unavailable' page|peer closed connection|RemoteProtocolError|not answer(ed)? the question within|not answered within|could not be reached|connection (was )?(reset|closed|refused)|server error event|indexing limit|'error_code': '[A-Z_]+_ERROR'/i;

/**
 * When more than this share of the suite failed transiently the gateway is
 * down, not blinking; re-running everything would double a run that is going to
 * fail anyway. The run keeps its errors instead.
 */
const RETRY_PASS_MAX_FRACTION = 0.5;

/**
 * A 401 part-way through a run means the Tableau session ended — in practice
 * another sign-in with the same PAT (a second copy of the tool, a Test
 * connection, a script): a token supports one live session. After
 * AUTH_STREAK_LIMIT cases fail that way within a short span the run pauses
 * itself, releases those cases so a resume re-runs them, and says why — instead
 * of burning the rest of the suite and reporting "finished". Cases finish out
 * of order when several conversations run at once, so "N in a row" becomes "N
 * among the last few" (a sliding window).
 *
 */
const AUTH_ERROR_RE =
  /\(401\)|\b401\b|unauthori[sz]ed|session (?:expired|invalid|ended)|sign-?in (?:failed|refused)/i;
const AUTH_STREAK_LIMIT = 3;
const AUTH_PAUSE_REASON = (n: number): string =>
  `${n} test cases in a row failed with 401 Unauthorized: the Tableau session ended, ` +
  "usually because this personal access token signed in somewhere else (another " +
  "copy of the tool, a connection test, a script). A token supports one live " +
  "session. Save a token that only this tool uses, then resume; those test cases " +
  "run again.";

// A 403 from the conversation endpoints means the site's per-feature AI switch
// is off for this account. The connection test can't see those switches (it
// uses the generations endpoint, which they don't gate), so the row must say so.
const FORBIDDEN_RE = /\(403\)|\b403\b|forbidden/i;
const HINT_403 =
  " — the site's AI feature for this capability is turned off for this account " +
  "(Site Settings > AI in Tableau > AI Settings by Feature). The connection test " +
  "does not check those switches.";
const HINT_401 =
  " — the Tableau session ended, usually because this personal access Token " +
  "signed in somewhere else; a token supports one live session.";

/** Judge calls in flight at once (env TABLEAU_AI_EVAL_JUDGE_CONCURRENCY, default 2). */
function judgeConcurrency(): number {
  const n = Number.parseInt(process.env.TABLEAU_AI_EVAL_JUDGE_CONCURRENCY ?? "2", 10);
  if (Number.isNaN(n)) return 2;
  return Math.max(1, Math.min(8, n));
}

/**
 * A tiny counting semaphore for the single-threaded event loop: `run(fn)`
 * executes `fn` with at most `limit` in flight, queueing the rest. Bounds judge
 * fan-out so a slow judge never holds up the runner.
 */
class Semaphore {
  private _inFlight = 0;
  private readonly _waiters: Array<() => void> = [];
  constructor(private readonly _limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this._inFlight >= this._limit) {
      await new Promise<void>((resolve) => this._waiters.push(resolve));
    }
    this._inFlight += 1;
    try {
      return await fn();
    } finally {
      this._inFlight -= 1;
      const next = this._waiters.shift();
      if (next) next();
    }
  }
}

/** The non-warning errors on a case. */
function realErrors(s: RowPayload): RowError[] {
  return (s.errors ?? []).filter(
    (e) => !(e.warning || (e as Record<string, unknown>).is_warning),
  );
}

/**
 * Whether the case produced any answer at all. Adapters serialize a case that
 * got nothing back as `actual: {}` (the harness initialises the result to an
 * empty dict), never `null`; only test fakes use `null`. Both mean "no answer",
 * as does a dict whose every value is empty. A single non-empty value (a
 * formula, a spec, a reply) is an answer, however wrong it may score.
 */
export function hasAnswer(s: RowPayload): boolean {
  const a = s.actual as unknown;
  if (a == null || a === "" || (Array.isArray(a) && a.length === 0)) return false;
  if (typeof a === "object") {
    return Object.values(a as Record<string, unknown>).some(
      (v) =>
        !(
          v == null ||
          v === "" ||
          (Array.isArray(v) && v.length === 0) ||
          (typeof v === "object" && v != null && Object.keys(v).length === 0)
        ),
    );
  }
  return true;
}

/** No result: the case produced no non-empty answer. */
function hasNoResult(s: RowPayload): boolean {
  return !hasAnswer(s);
}

/** Dashboard Q&A can return a generated apology alongside a server error. */
function hasCabuFailure(s: RowPayload): boolean {
  return s.runner === "cabu-dashboard-qa" && realErrors(s).some((e) => e.phase === "cabu");
}

/** No answer, or a Dashboard Q&A server failure, with a non-warning error. */
export function isFailedCase(s: RowPayload): boolean {
  return (hasNoResult(s) || hasCabuFailure(s)) && realErrors(s).length > 0;
}

/** A failed case whose errors read as a lost Tableau session (401). */
function isAuthFailure(s: RowPayload): boolean {
  return (
    isFailedCase(s) &&
    realErrors(s).some((e) => AUTH_ERROR_RE.test(String(e.description ?? "")))
  );
}

/** Append what a 401 or 403 means to the error text the row will show. */
function annotateErrors(s: RowPayload): void {
  for (const e of realErrors(s)) {
    const desc = String(e.description ?? "");
    if (FORBIDDEN_RE.test(desc) && !desc.includes(HINT_403)) {
      e.description = desc + HINT_403;
    } else if (AUTH_ERROR_RE.test(desc) && !desc.includes(HINT_401)) {
      e.description = desc + HINT_401;
    }
  }
}

/**
 * The formula checker reports an empty formula as a parser error at the end of
 * input, followed by what the grammar could have accepted. Neither tells an
 * admin anything: the model simply did not write a formula. / `_plain_explanation(s)`.
 */
export const NO_FORMULA_EXPLANATION =
  "The model did not write a formula for this request, so there was nothing to check.";
const NO_FORMULA_RE =
  /^(?:Syntax Error: )?Syntax error at line 1, column 0: mismatched input '<EOF>'|^Empty formula$/;
// Strip ANTLR's `expecting {tok, tok, …}` / `expecting TOK`. The
// parser can also word the same clause as
// `expecting a value expression` / `expecting a field`, so a lower-case
// `a|an <words>` phrase is stripped too.
const EXPECTING_RE = /\s+expecting\s+(?:\{[\s\S]*?\}|an? [a-z ]*[a-z]|\S+)/g;

/** A metric explanation in words: no parser token lists. */
export function plainExplanation<T>(text: T): T {
  if (Array.isArray(text)) return text.map((t) => plainExplanation(t)) as T;
  if (typeof text !== "string") return text;
  if (NO_FORMULA_RE.test(text.trim())) return NO_FORMULA_EXPLANATION as T;
  return (text.includes("Syntax error") ? text.replace(EXPECTING_RE, "") : text) as T;
}

/** Rewrite the formula checker's raw explanations on a case, in place. */
function plainExplanations(s: RowPayload): void {
  for (const entries of Object.values(s.metrics ?? {})) {
    for (const m of entries ?? []) {
      if (m && typeof m === "object" && m.explanation) {
        m.explanation = plainExplanation(m.explanation);
      }
    }
  }
}

/** The most common error text among failed cases, for the run tile. */
function dominantError(descriptions: Iterable<string>): string | null {
  const counts = new Map<string, number>();
  for (const d of descriptions) {
    if (!d) continue;
    const key = String(d).slice(0, 200);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return null;
  let best = "";
  let bestN = 0;
  for (const [text, n] of counts) {
    if (n > bestN) {
      best = text;
      bestN = n;
    }
  }
  return `${bestN} case${bestN !== 1 ? "s" : ""}: ${best}`;
}

/**
 * Retry failed cases only when every non-warning error reads as a transient
 * gateway/network failure. A Dashboard Q&A apology does not make it successful.
 */
export function isTransientFailure(s: RowPayload): boolean {
  if (!isFailedCase(s)) return false;
  const errors = realErrors(s);
  if (!errors.length) return false;
  return errors.every((e) => {
    const description = String(e.description ?? "");
    return TRANSIENT_ERROR_RE.test(description) || (
      s.runner === "cabu-dashboard-qa" && e.phase === "cabu" &&
      /I\/O error on (?:POST|GET) request|UnknownHostException|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|service (?:is )?(?:not available|unavailable)/i.test(description)
    );
  });
}

// ---------------------------------------------------------------------------
// Per-case processing: judge attach + persistence
// ---------------------------------------------------------------------------

/**
 * Cap debug_info to a byte budget. Returns the stored value AND its serialized
 * JSON (`json`) so the DB layer stores it without a second JSON.stringify.
 * `json` is `null` for empty debug_info (stored as SQL NULL).
 *   - under budget: original object, serialized once here;
 *   - over budget:  a truncated preview marker, serialized here;
 *   - unserializable: falls back to the String() form (matches prior behavior).
 */
function capDebugInfo(debugInfo: unknown): { stored: unknown; json: string | null } {
  if (!debugInfo) return { stored: debugInfo, json: null };
  let serialized: string;
  try {
    serialized = JSON.stringify(debugInfo);
  } catch {
    serialized = String(debugInfo);
  }
  if (serialized.length <= DEBUG_INFO_MAX_BYTES) {
    return { stored: debugInfo, json: serialized };
  }
  const marker = {
    _truncated: true,
    _original_bytes: serialized.length,
    preview: serialized.slice(0, DEBUG_INFO_MAX_BYTES),
  };
  return { stored: marker, json: JSON.stringify(marker) };
}

/**
 * The expected answer in words, for a case whose expected answer is a chart
 * and no written reply: the Information Similarity score compares the
 * model's reply to this description, and the results page shows it under
 * the expected chart so the comparison can be read (bug bash 2026-10-23,
 * item 17). Stored with the row's `info`, so old runs simply have none.
 */
export function describeExpected(s: RowPayload): void {
  const expected = s.expected as Record<string, unknown> | null | undefined;
  if (!expected || typeof expected !== "object") return;
  const reply = expected.userFriendlyReply || expected.user_friendly_reply;
  const spec = expected.notionalSpec;
  if (reply || !spec || typeof spec !== "object") return;
  const description = describeSpec(spec as Record<string, unknown>);
  if (!description) return;
  s.info = { ...(s.info || {}), expected_description: description };
}

/** Write one serialized case result to SQLite. Returns false on failure. */
function persistSerialized(
  deps: OrchestratorDeps,
  jobId: string,
  s: RowPayload,
): boolean {
  try {
    // One transaction per case: result + all stage metrics + errors together
    // (was 2+ implicit transactions). persistCaseResult skips empty stages.
    const debug = capDebugInfo(s.debug_info);
    deps.db.persistCaseResult(
      {
        job_id: jobId,
        test_case_id: s.test_case_id,
        runner: s.runner,
        datasource: s.datasource,
        utterance: s.utterance,
        expected: s.expected,
        actual: s.actual,
        latency: s.latency,
        debug_info: debug.stored,
        // Pass the already-serialized JSON so the DB doesn't re-stringify it.
        debug_info_json: debug.json,
        info: s.info,
      },
      s.metrics,
      s.errors ?? [],
    );
    return true;
  } catch (err) {
    deps.log?.(`Failed to persist test case ${s.test_case_id} to SQLite`, err);
    return false;
  }
}

/** Pull (utterance, expected_reply, actual_reply, expected_spec) for the judge. */
function extractReplies(s: RowPayload): {
  utterance: string;
  expectedReply: string | null;
  actualReply: string | null;
  expectedSpec: Record<string, unknown> | null;
} {
  const utterance = s.utterance || "";
  const expected = s.expected || {};
  const actual = s.actual || {};
  let expectedReply: string | null = null;
  let actualReply: string | null = null;
  let expectedSpec: Record<string, unknown> | null = null;
  if (expected && typeof expected === "object") {
    expectedReply =
      (expected.userFriendlyReply as string) ||
      (expected.user_friendly_reply as string) ||
      null;
    expectedSpec = (expected.notionalSpec as Record<string, unknown>) ?? null;
  }
  if (actual && typeof actual === "object") {
    actualReply =
      (actual.userFriendlyReply as string) ||
      (actual.user_friendly_reply as string) ||
      null;
  }
  if (!actualReply) {
    const dbg = s.debug_info;
    if (dbg && typeof dbg === "object") {
      const llmReq = (dbg as Record<string, unknown>).llm_request;
      if (llmReq && typeof llmReq === "object") {
        actualReply =
          ((llmReq as Record<string, unknown>).userFriendlyReply as string) ||
          ((llmReq as Record<string, unknown>).user_friendly_reply as string) ||
          null;
      }
    }
  }
  return { utterance, expectedReply, actualReply, expectedSpec };
}

/**
 * The calculated-field formula in an expected or actual answer, so the judge
 * reads a calculation's explanation against the formulas.
 */
export function formulaOf(answer: unknown): string | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const a = answer as Record<string, unknown>;
  const calc = a.calculatedFieldFormula;
  if (calc && typeof calc === "object" && typeof (calc as Record<string, unknown>).formula === "string") {
    return ((calc as Record<string, unknown>).formula as string) || null;
  }
  if (typeof a.calculation === "string") return a.calculation || null;
  return null;
}

/** Attach LLM-judge NL metrics to a serialized case result. Never throws. */
async function attachJudgeMetrics(
  deps: OrchestratorDeps,
  s: RowPayload,
  judgeCfg: Record<string, unknown> | null,
): Promise<void> {
  if (!judgeCfg) return;
  if (s.runner === "cabu-dashboard-qa") return;
  try {
    if (s.actual && "insightNarrative" in s.actual) {
      const entries = await computeNarrativeJudgeMetrics({
        expectedNarrative: s.expected?.insightNarrative,
        actualNarrative: s.actual.insightNarrative,
        truths: s.debug_info?.narrative_truths as NarrativeTruths | undefined,
        judgeCfg,
      }, { fetchFn: deps.judgeFetch, retry: deps.judgeRetry });
      if (entries.length) {
        s.metrics[JUDGE_STAGE] ??= [];
        s.metrics[JUDGE_STAGE].push(...entries);
      }
      return;
    }
    const { utterance, expectedReply, actualReply, expectedSpec } =
      extractReplies(s);
    if (!actualReply) {
      // A palette answer has no prose to judge, but it has its own rubric:
      // score it with the configured judge rather than letting the evaluator's
      // pinned-model metric call the site (palette_judge.ts). The three scores
      // land in the judge stage; without a configured judge they are simply
      // absent, and a judge failure shows "Unavailable" per metric.
      const actual = (s.actual ?? {}) as Record<string, unknown>;
      if (actual && typeof actual === "object" && actual.colorPalette != null) {
        const paletteEntries = await computePaletteJudgeMetrics(
          {
            utterance,
            paletteType:
              typeof actual.paletteType === "string" ? actual.paletteType : null,
            palette: actual.colorPalette,
            judgeCfg,
          },
          { fetchFn: deps.judgeFetch, retry: deps.judgeRetry },
        );
        if (paletteEntries.length) {
          s.metrics[JUDGE_STAGE] ??= [];
          s.metrics[JUDGE_STAGE].push(...paletteEntries);
        }
        return;
      }
      // NL judge skipped: no actual_reply produced by runner.
      return;
    }
    const entries: ComputedMetric[] = await computeJudgeMetrics(
      {
        utterance,
        expectedReply,
        actualReply,
        expectedSpec,
        judgeCfg,
        expectedFormula: formulaOf(s.expected),
        actualFormula: formulaOf(s.actual),
        calculationCase: Boolean(s.expected && ("calculatedFieldFormula" in s.expected || "calculation" in s.expected)),
      },
      { fetchFn: deps.judgeFetch, retry: deps.judgeRetry },
    );
    if (entries && entries.length) {
      s.metrics[JUDGE_STAGE] ??= [];
      s.metrics[JUDGE_STAGE].push(...entries);
    }
  } catch (err) {
    deps.log?.(`Judge attachment failed for ${s.test_case_id}`, err);
  }
}

// ---------------------------------------------------------------------------
// Embedded CES bridge lifecycle
// ---------------------------------------------------------------------------

/**
 * Build the run's one Tableau session from the PAT triplet and register it as
 * the run's SHARED session (keyed by jobId), so everything in the run that
 * signs in with the PAT — the embedded CES bridge and the harness runner —
 * uses the same token instead of ending each other's session (a PAT allows one
 * live session). Also stamps `config.job_id` so the harness runner can find it.
 * Returns the session (or null when the PAT triplet is incomplete).
 *
 * One session is shared by the runner and bridge for the run's lifetime.
 */
export function shareRunSession(
  deps: OrchestratorDeps,
  config: RunConfig,
  jobId: string,
): TableauSession | null {
  const onAuthFailure = (reason: string) => {
    // Dead PAT: auto-pause at the next case boundary so the admin can mint a
    // new PAT and resume, instead of burning the rest of the suite on 401s.
    deps.log?.(`Job ${jobId} auto-pausing: ${reason}`);
    lifecycle(deps).requestPause(jobId, reason, deps.executionId);
  };
  const session = sessionFromRunConfig(config, {
    onAuthFailure,
    fetchImpl: deps.cesFetch,
  });
  config.job_id = jobId;
  if (session) {
    shareSession(jobId, session);
  }
  return session;
}

/**
 * Start the embedded EGPT→CES bridge when the run requests ces mode. Returns
 * the bridge (caller stops it in its finally) or null when not ces mode.
 * Mutates `config` in place to re-point runners at the local bridge.
 *
 * `session` is the run's shared session (see {@link shareRunSession}). When
 * omitted (e.g. a focused test), a session is built from the config's PAT
 * triplet so the bridge still authenticates and its dead-PAT auto-pause fires.
 */
export function maybeStartCesBridge(
  deps: OrchestratorDeps,
  config: RunConfig,
  jobId: string,
  session?: TableauSession | null,
): CesBridge | null {
  if (String(config.generations_mode ?? "").toLowerCase() !== "ces") {
    return null;
  }
  const cesHost = (config.ces_url as string) || "";
  if (!cesHost) {
    throw new Error("generations_mode=ces requires ces_url");
  }

  // Build a session from the config when the caller didn't hand one in.
  const resolvedSession =
    session === undefined
      ? sessionFromRunConfig(config, {
          onAuthFailure: (reason: string) => {
            deps.log?.(`Job ${jobId} auto-pausing: ${reason}`);
            lifecycle(deps).requestPause(jobId, reason, deps.executionId);
          },
          fetchImpl: deps.cesFetch,
        })
      : session;

  const bridge = new CesBridge({
    cesHost,
    session: resolvedSession ?? undefined,
    verify: (config.verify_tls as boolean) ?? true,
    caBundlePath: config.ca_bundle_path as string | undefined,
    fetchImpl: deps.cesFetch,
    // Production uses a real exponential backoff (5–30s); tests inject 0.
    retryDelayMs: deps.cesRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    signal: config._run_signal as AbortSignal | undefined,
  });
  const baseUrl = bridge.start();
  // The runners are pointed at the loopback bridge for this process's
  // lifetime only. runNlqEvalJob works on a copy of the config, so the
  // address never reaches the stored run record or a resume (it used to:
  // published rows said the model was answered by 127.0.0.1:<dead port>).
  config.bridge_url = baseUrl;
  config.gateway_url = baseUrl;
  config.llm_key = config.llm_key || "local-ces-bridge";
  return bridge;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Drive one evaluation run through its adapter. */
export async function runNlqEval(
  deps: OrchestratorDeps,
  jobId: string,
  config: RunConfig,
): Promise<void> {
  // Public direct-entry seam used by offline harness tests as well as the job wrapper.
  if (!deps.db.getRun(jobId)) deps.db.createRun({ job_id: jobId,
    org_id: String(config.org_id ?? ""), user_id: String(config.user ?? ""),
    ai_feature: String(config.ai_feature ?? ""), runner_name: String(config.runner ?? ""), config });
  const resolveAdapter = deps.getAdapter ?? defaultGetAdapter;
  const adapter = await resolveAdapter(config);

  let cesBridge: CesBridge | null = null;
  try {
    if ((config._run_signal as AbortSignal | undefined)?.aborted || getControl(deps, jobId)) return;
    // Each preparation phase is named for the admin and timed in the log, so a
    // run that sits "queued" or "preparing" for minutes says where the time
    // went (bug bash 2026-10-23, item 10).
    const phaseClock = { label: "", startedAt: Date.now() };
    const phase = (label: string | null): void => {
      const now = Date.now();
      if (phaseClock.label) deps.log?.(`Job ${jobId}: ${phaseClock.label} took ${((now - phaseClock.startedAt) / 1000).toFixed(1)} s`);
      phaseClock.label = label || "";
      phaseClock.startedAt = now;
      // The phase only: the status was set once below, and a run cancelled
      // meanwhile must not be written back to "started".
      if (authorized(deps, jobId) && !getControl(deps, jobId)) writeState(deps, jobId, { phase: label });
    };
    writeState(deps, jobId, { status: "started", phase: "Signing in to the server" });
    phaseClock.label = "Signing in to the server";
    // The run's one shared Tableau session: registered before the bridge and
    // the adapter so everything that signs in with the PAT uses one token.
    const runSession = shareRunSession(deps, config, jobId);
    // Bridge starts before the adapter session: it overrides gateway_url so
    // the adapter's credential injection points runners at the bridge.
    cesBridge = maybeStartCesBridge(deps, config, jobId, runSession);

    const session = await adapter.session(config, jobId);
    try {
      if (config.identity_pending && runSession) {
        phase("Reading the site's AI model settings");
        delete config.identity_pending;
        try {
          const token = await runSession.getToken();
          const siteId = await runSession.siteId();
          const site = await probeSiteModels(String(config.tableau_server || ""), token, siteId || "", {
            verify: config.verify_tls !== false,
            caBundlePath: config.ca_bundle_path as string | undefined,
          }, deps.cesFetch);
          if (siteId) config.tableau_site_luid = siteId;
          if (site.model_under_test) config.resolved_site_model = site.model_under_test;
          if (site.provider) config.site_model_provider = site.provider;
          if (authorized(deps, jobId)) deps.db.updateRunConfig(jobId, {
            tableau_site_luid: siteId,
            resolved_site_model: config.resolved_site_model,
            site_model_provider: config.site_model_provider,
          });
          if (config.resolved_site_model) writeState(deps, jobId, { model_name: config.resolved_site_model });
        } catch (error) {
          deps.log?.(`Job ${jobId}: could not read the site's model with the run's session`, error);
        }
      }
      if (config.adapter === "cabu" && config._content_from_tool && runSession) {
        const store = {
          getSetting: (key: string) => deps.db.getSetting(key),
          setSetting: (key: string, value: unknown) => deps.db.setSetting(key, value),
        };
        const suiteId = String(config.suite_id || "");
        const parts = partsOf(suiteId, publicSuitesRoot());
        if (parts.length) config._suite_parts = parts;
        const idsByPart: Record<string, Record<string, unknown>> = {};
        // A part asks about its own sample dashboard, named by its content
        // id. Two parts about the same dashboard (a dashboard's data
        // questions and its declines) share one publish and one set of ids.
        const idsByContent: Record<string, Record<string, unknown>> = {};
        for (const [index, part] of (parts.length ? parts : [{ id: suiteId, content: undefined }]).entries()) {
          const id = part.content ?? part.id;
          if (idsByContent[id]) {
            idsByPart[part.id] = idsByContent[id];
            continue;
          }
          const server = String(config.tableau_server || "");
          const site = String(config.tableau_site || "");
          let ids = dashboardContent.runIdsFor(store, id, server, site);
          if (ids.workbook_luid && !dashboardContent.rememberedContentIsCurrent(id, dashboardContent.storedContent(store, server, site, id))) {
            // The suite's sample content changed since it was published: ask
            // about the current content, not the old data (2026-10-21).
            ids = {};
          }
          if (ids.workbook_luid && !await dashboardContent.workbookExists(runSession, String(ids.workbook_luid), {
            verify: config.verify_tls !== false,
            caBundlePath: config.ca_bundle_path as string | undefined,
          })) ids = {};
          if (!Object.keys(ids).length) {
            phase(`Publishing sample content${parts.length ? ` (${index + 1} of ${parts.length})` : ""}`);
            try {
              await dashboardContent.publishSuiteContent(id, { server_url: server, site }, {
                session: runSession, store,
                verify: config.verify_tls !== false,
                caBundlePath: config.ca_bundle_path as string | undefined,
              });
            } finally {
              phase("Preparing evaluation");
            }
            ids = dashboardContent.runIdsFor(store, id, server, site);
          } else {
            phase("Checking the sample content on the server");
          }
          idsByContent[id] = ids;
          if (parts.length) idsByPart[part.id] = ids;
          else Object.assign(config, ids);
        }
        if (parts.length) config._part_ids = idsByPart;
      }
      phase("Loading the test cases");
      const plan = await adapter.load(config);
      phase(null);
      // Sign-in, identity lookup and suite loading yield. A control request
      // during any of them must not be overwritten by the START below.
      if ((config._run_signal as AbortSignal | undefined)?.aborted || getControl(deps, jobId) || !isStillActive(deps, jobId)) return;
      const nTestCases = plan.total;

      // ---- Resume skip-list ----
      const completedIds = new Set(deps.db.getCompletedTestCaseIds(jobId));
      let completedCount = 0;
      if (completedIds.size) {
        // Cases that failed on the gateway before the interruption never
        // reached the retry pass of the pass they ran in (the tool was
        // restarted mid-run on 2026-10-12: 130 such rows stayed as errors).
        // Give them the retry now, whole conversations at a time, as the
        // retry pass would.
        const stale = new Set(
          deps.db
            .getPersistedOutcomes(jobId)
            .filter((o) => completedIds.has(o.test_case_id) && isTransientFailure(o as RowPayload))
            .map((o) => o.test_case_id),
        );
        if (stale.size) {
          const release = new Set<string>();
          for (const convIds of plan.conversation_ids) {
            if (convIds.some((cid) => stale.has(cid))) for (const cid of convIds) release.add(cid);
          }
          lifecycle(deps).commit(jobId, { resetIds: [...release] },
            { executionId: deps.executionId, write: () => deps.db.deleteTestCaseResults(jobId, [...release]) });
          for (const cid of release) completedIds.delete(cid);
          deps.log?.(
            `Job ${jobId} resuming: re-running ${release.size} case(s) that failed on the ` +
              "gateway before the run was interrupted",
          );
        }
        for (const convIds of plan.conversation_ids) {
          const doneIds = convIds.filter((cid) => completedIds.has(cid));
          if (!doneIds.length) continue;
          if (doneIds.length === convIds.length) {
            completedCount += convIds.length;
          } else {
            lifecycle(deps).commit(jobId, { resetIds: doneIds },
              { executionId: deps.executionId, write: () => deps.db.deleteTestCaseResults(jobId, doneIds) });
            for (const d of doneIds) completedIds.delete(d);
          }
        }
        deps.log?.(
          `Job ${jobId} resuming: ${completedCount}/${nTestCases} case(s) already complete`,
        );
      }

      // ---- START event + up-front skeletons ----
      writeState(deps, jobId, {
        status: "started",
        completed: completedCount,
        total: nTestCases,
        // No case is in flight yet, and averages cached when the run last
        // ended describe fewer cases than it is about to have.
        running_case_ids: [],
        phase: null,
        score_version: null,
      });
      spub(deps, jobId, { type: "start", total: nTestCases, status: "started" });
      lifecycle(deps).commit(jobId, { cases: plan.skeletons }, { executionId: deps.executionId });
      // On resume, don't re-emit skeletons (already in the durable log).
      if (
        plan.skeletons &&
        plan.skeletons.length &&
        deps.db.getEvents(jobId, 0, ["skeletons"]).length === 0
      ) {
        spub(deps, jobId, { type: "skeletons", items: plan.skeletons });
      }

      // ---- BYOK judge: settings table only. ----
      let judgeCfg: Record<string, unknown> | null = null;
      if (config.compute_nl_judge) {
        judgeCfg = deps.db.getSetting<Record<string, unknown>>("judge") || null;
        if (judgeCfg) {
          config._judge_config = judgeCfg;
          writeState(deps, jobId, {
            judge_provider: (judgeCfg.provider as string) ?? "",
            judge_model: (judgeCfg.model as string) || "",
          });
        } else {
          deps.log?.(
            `compute_nl_judge requested but no judge configured — judge metrics disabled for job ${jobId}`,
          );
        }
      }

      // Mutable counters shared with the emit callback (single-threaded event
      // loop — no locks needed).
      let completedRef = completedCount;
      // Cases whose only errors were a gateway 5xx / network failure — candidates
      // for the post-suite retry pass.
      const transientFailed = new Set<string>();
      // Failed cases (no result + real error) + their dominant error text, and
      // a 401 window that triggers a mid-run auto-pause-and-release. Cases
      // finish out of order when several conversations run at once, so "N 401s
      // in a row" becomes "N 401s among the last few": a window of the last
      // (limit + concurrency - 1) outcomes, which with one conversation at a
      // time is exactly the old strict streak.
      const failedIds = new Set<string>();
      const failedDesc = new Map<string, string>();
      const maxConcurrency = resolveMaxConcurrency(config);
      const authWindowSize = AUTH_STREAK_LIMIT + maxConcurrency - 1;
      const authWindow: number[] = [];
      const authFailed = new Set<string>();
      // Judge calls fan out with the conversations; bound them on their own so
      // a slow judge never holds the runner limiter.
      const judgeSem = new Semaphore(judgeConcurrency());

      // All conversation ids that touch any of `ids` (release whole
      // conversations, like resume — a multi-turn case can't re-run alone).
      const conversationsOf = (ids: Set<string>): Set<string> => {
        const out = new Set<string>();
        for (const convIds of plan.conversation_ids) {
          if (convIds.some((cid) => ids.has(cid))) {
            for (const cid of convIds) out.add(cid);
          }
        }
        return out.size ? out : new Set(ids);
      };

      // Drop the rows of every case that lost its session, so a resume runs
      // them again; returns how many were released.
      const releaseAuthFailed = (): number => {
        if (!authFailed.size) return 0;
        const released = conversationsOf(authFailed);
        completedRef = Math.max(0, completedRef - released.size);
        lifecycle(deps).commit(jobId, { resetIds: [...released], run: { completed: completedRef } },
          { executionId: deps.executionId, write: () => deps.db.deleteTestCaseResults(jobId, [...released]) });
        for (const cid of released) {
          failedIds.delete(cid);
          failedDesc.delete(cid);
          transientFailed.delete(cid);
        }
        authFailed.clear();
        authWindow.length = 0;
        return released.size;
      };

      // Session lost mid-run: pause, release the affected conversations so a
      // resume re-runs them, and name the cause.
      const pauseForLostSession = (): void => {
        const nAuth = authFailed.size;
        const released = releaseAuthFailed();
        deps.log?.(
          `Job ${jobId}: ${nAuth} 401s in quick succession — pausing and releasing ${released} case(s)`,
        );
        lifecycle(deps).requestPause(jobId, AUTH_PAUSE_REASON(nAuth), deps.executionId);
      };

      // The cases being worked on right now. The adapter reports each start;
      // the page shows those rows as running and the rest of the unfinished
      // ones as queued.
      const runningIds = new Set<string>();
      plan.case_started = (caseId: string): void => {
        if (!authorized(deps, jobId) || getControl(deps, jobId) === "cancel" || (config._run_signal as AbortSignal | undefined)?.aborted) return;
        runningIds.add(caseId);
        const ids = [...runningIds].sort();
        writeState(deps, jobId, { running_case_ids: ids });
        spub(deps, jobId, { type: "running", ids });
      };

      const emitCase = async (serialized: RowPayload): Promise<void> => {
        if (!authorized(deps, jobId) || getControl(deps, jobId) === "cancel" || (config._run_signal as AbortSignal | undefined)?.aborted) return;
        await judgeSem.run(() => attachJudgeMetrics(deps, serialized, judgeCfg));
        if (!authorized(deps, jobId) || getControl(deps, jobId) === "cancel" || (config._run_signal as AbortSignal | undefined)?.aborted) return;
        // No await below this line: with several conversations in flight, the
        // bookkeeping, the row event, the persist and the counters below are
        // atomic only because nothing yields.
        annotateErrors(serialized);
        plainExplanations(serialized);
        describeExpected(serialized);
        serialized.debug_info = capDebugInfo(serialized.debug_info).stored as RowPayload["debug_info"];
        const cid = serialized.test_case_id;
        if (isTransientFailure(serialized)) {
          transientFailed.add(cid);
        } else {
          transientFailed.delete(cid);
        }
        if (isFailedCase(serialized)) {
          failedIds.add(cid);
          failedDesc.set(cid, String(realErrors(serialized)[0]?.description ?? ""));
        } else {
          failedIds.delete(cid);
          failedDesc.delete(cid);
        }
        const isAuth = isAuthFailure(serialized);
        authWindow.push(isAuth ? 1 : 0);
        if (authWindow.length > authWindowSize) authWindow.shift();
        if (isAuth) {
          authFailed.add(cid);
        } else {
          authFailed.delete(cid); // a re-run of this case succeeded
        }
        const remaining = [...runningIds].filter(id => id !== cid).sort();
        const committed = lifecycle(deps).commit(jobId, {
          results: [serialized], runningIds: remaining,
          run: { completed: completedRef + 1, total: nTestCases },
        }, { executionId: deps.executionId, write: () => {
          if (!persistSerialized(deps, jobId, serialized)) throw new Error("Case result could not be persisted");
        } });
        if (!committed) return;
        runningIds.delete(cid);
        completedRef += 1;
        // Compatibility stream only; the observation stream uses the atomic change above.
        spub(deps, jobId, { type: "row", payload: serialized });
        const authCount = authWindow.reduce((a, b) => a + b, 0);
        if (authCount >= AUTH_STREAK_LIMIT && !getControl(deps, jobId)) {
          pauseForLostSession();
        }
        // Skip the progress update if a control request landed OR the run is
        // already in a terminal/paused state, to avoid resurrecting a
        // cancelled/paused/failed run back to "started" (TOCTOU: a /cancel or
        // /pause may have landed during the awaits above). Re-reads control and
        // run status immediately before the write; never downgrades a terminal
        // state.
        if (isStillActive(deps, jobId)) {
          spub(deps, jobId, {
            type: "progress",
            completed: completedRef,
            total: nTestCases,
            // Every surface reads status from the same place: the event that
            // changes it (bug bash 2026-09-23, home said Queued while the
            // results page said Running).
            status: "started",
          });
        }
      };

      // Once the adapter has been told to stop it has skipped cases, so this
      // pass cannot end as "finished" whatever happens to the flag afterwards.
      // A resume that arrives while the pause is still landing clears the flag
      // and queues the run again: without the latch, this pass then closed the
      // run as finished with the skipped cases missing, moments before the
      // queued pass picked them up (calcs-public, 2026-10-01: "Complete" at 137
      // of 166).
      let stopSeen: string | null = null;
      const shouldStop = (): string | null => {
        const control = getControl(deps, jobId);
        if (control && (stopSeen === null || control === "cancel")) stopSeen = control;
        return control || stopSeen;
      };

      await adapter.execute(plan, config, emitCase, shouldStop, completedIds);
      if (!authorized(deps, jobId) || (config._run_signal as AbortSignal | undefined)?.aborted) return;

      // ---- Retry pass for gateway/network failures ----
      // Conversation granularity, like resume: a multi-turn case cannot be
      // re-run alone because its history is not rebuilt from rows, so the whole
      // conversation goes again.
      if (transientFailed.size && !shouldStop()) {
        const retryIds = new Set<string>();
        for (const convIds of plan.conversation_ids) {
          if (convIds.some((cid) => transientFailed.has(cid))) {
            for (const cid of convIds) retryIds.add(cid);
          }
        }
        const allIds = new Set<string>();
        for (const convIds of plan.conversation_ids) {
          for (const cid of convIds) allIds.add(cid);
        }
        const share = nTestCases ? retryIds.size / nTestCases : 0;
        if (share > RETRY_PASS_MAX_FRACTION) {
          // More than half the suite failed transiently — the gateway looks
          // down, not blinking; don't double a run that will fail anyway. No
          // stream event: the results stream treats "error" as terminal, and
          // every affected row already carries its own gateway error.
          deps.log?.(
            `Job ${jobId}: ${retryIds.size}/${nTestCases} case(s) failed on the gateway — ` +
              `more than ${RETRY_PASS_MAX_FRACTION * 100}%, so the gateway looks down; not retrying.`,
          );
        } else {
          deps.log?.(
            `Job ${jobId}: retrying ${retryIds.size} case(s) that failed on the gateway`,
          );
          // Progress climbs back to the total as the retried cases come in,
          // instead of overshooting it.
          completedRef = Math.max(0, completedRef - retryIds.size);
          transientFailed.clear();
          const skip = new Set(allIds);
          for (const cid of retryIds) skip.delete(cid);
          // Say so, or the page shows a finished suite going back to
          // "16 of 18" for no visible reason: those rows return to waiting,
          // labelled as a second attempt.
          const retrying = [...retryIds].sort();
          lifecycle(deps).commit(jobId, { resetIds: retrying, retryingIds: retrying,
            run: { completed: completedRef }, state: { retrying_case_ids: retrying } },
            { executionId: deps.executionId, write: () => deps.db.deleteTestCaseResults(jobId, retrying) });
          spub(deps, jobId, { type: "retrying", ids: retrying });
          spub(deps, jobId, {
            type: "progress",
            completed: completedRef,
            total: nTestCases,
            status: "started",
          });
          try {
            await adapter.execute(plan, config, emitCase, shouldStop, skip);
          } finally {
            writeState(deps, jobId, { retrying_case_ids: [] });
          }
        }
      }

      // ---- Done: three-way on the control flag ----
      const control = getControl(deps, jobId);
      if (control === "cancel") {
        writeState(deps, jobId, { status: "cancelled" });
        spub(deps, jobId, { type: "done", status: "cancelled" });
      } else if (control === "pause") {
        // Conversations that were in flight when the pause landed may have lost
        // their session too; release those rows as well, so the resume re-runs
        // them instead of keeping 401s.
        if (authFailed.size) {
          deps.log?.(
            `Job ${jobId}: releasing ${releaseAuthFailed()} case(s) that hit 401 while pausing`,
          );
        }
        writeState(deps, jobId, {
          status: "paused",
          completed: completedRef,
          total: nTestCases,
        });
        spub(deps, jobId, { type: "done", status: "paused" });
      } else if (stopSeen) {
        // Paused, then resumed before this pass had wound down: the resume has
        // queued the run again and that pass runs what this one skipped. Leave
        // the status and the stream alone.
        if (authFailed.size) releaseAuthFailed();
        writeState(deps, jobId, { completed: completedRef, total: nTestCases });
        deps.log?.(
          `Job ${jobId}: resumed while pausing at ${completedRef}/${nTestCases}; the queued pass continues it`,
        );
      } else {
        // A run whose cases errored still "finished" (it ran to the end), but
        // the tile/header must not read as a clean completion: the count + the
        // dominant error ride on the state so every surface can say "finished
        // with N errors".
        const nFailed = failedIds.size;
        const dominant = nFailed ? dominantError(failedDesc.values()) : null;
        writeState(deps, jobId, {
          status: "finished",
          completed: nTestCases,
          total: nTestCases,
          persist_failures: 0,
          failed_cases: nFailed,
          dominant_error: dominant,
        });
        spub(deps, jobId, {
          type: "done",
          status: "finished",
          persist_failures: 0,
          failed_cases: nFailed,
        });
      }
    } finally {
      await session.close();
    }
  } finally {
    if (deps.db.getRun(jobId) && authorized(deps, jobId)) writeState(deps, jobId, { running_case_ids: [], phase: null });
    unshareSession(jobId);
    if (cesBridge !== null) {
      try {
        cesBridge.stop();
      } catch (err) {
        deps.log?.(`Failed to stop CES bridge for job ${jobId}`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

/**
 * Worker-queue entrypoint (submitted by the routes layer via the JobQueue) —
 *
 *
 * 1. Initializes SQLite (creates tables if needed).
 * 2. Creates/updates the run record so results have metadata even before any
 *    test cases complete.
 * 3. Delegates to `runNlqEval`.
 * 4. On failure, publishes error + done events and marks the run failed.
 */
const NETWORK_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * What the results page shows when a run stops before its first case or
 * between cases: what went wrong and what to do, in the admin's terms. The
 * log keeps the stack.
 *
 * An ImportError branch ("a package is not installed")
 * has no counterpart in a compiled binary. A missing file or folder is reported by its ENOENT / ENOTDIR code,
 * and a suite with nothing to run is the harness/adapter
 * "no runnable … / no … files found / not found" errors.
 */
export function friendlyFailure(exc: unknown): string {
  const text = (exc instanceof Error ? exc.message : String(exc)).trim() ||
    (exc instanceof Error ? exc.name : "Error");
  const code = String((exc as { code?: unknown })?.code ?? "");
  const name = exc instanceof Error ? exc.name : "";
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    /not found|no runnable|no (?:case|suite) files found/i.test(text)
  ) {
    return (
      `The test suite could not be loaded: ${text}. Check that the suite's files ` +
      "are on this computer (the home page lists the suites it found), then " +
      "evaluate again."
    );
  }
  if (exc instanceof TableauAuthError) return text; // already says what to do about the token
  if (text.includes("failed the same way, so the rest were not asked")) {
    return text; // the adapter stopped the run and already says why
  }
  if (name === "TimeoutError" || NETWORK_ERROR_CODES.has(code)) {
    return (
      `Tableau Server could not be reached (${text}). Check the VPN and the ` +
      "network, test the connection in Evaluation Setup, step 1, then evaluate again."
    );
  }
  return (
    `The evaluation stopped before it finished: ${text}. The tool's output (the ` +
    "terminal where it was started) has the details."
  );
}

export async function runNlqEvalJob(
  deps: OrchestratorDeps,
  config: RunConfig,
  jobId: string,
): Promise<void> {
  deps.db.initDb();
  // A private copy: the bridge rewrites gateway_url / llm_key for the runners,
  // and those process-local values must not leak into the caller's config
  // (cached for resume) or the persisted run record.
  config = { ...config };
  if (getControl(deps, jobId)) return;
  const controller = new AbortController();
  deps.runControllers?.set(jobId, controller);
  config._run_signal = controller.signal;
  const fetchImpl = deps.cesFetch ?? fetch;
  const runFetch: typeof fetch = Object.assign((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetchImpl(url, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal,
  }), { preconnect: fetchImpl.preconnect });
  const judgeFetch = deps.judgeFetch ?? fetch;
  const runJudgeFetch: typeof fetch = Object.assign((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    controller.signal.throwIfAborted();
    return judgeFetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  }, { preconnect: judgeFetch.preconnect });
  const retry = deps.judgeRetry ?? DEFAULT_RETRY_POLICY;
  const judgeRetry: RetryPolicy = {
    ...retry,
    sleep: async ms => {
      controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        retry.sleep(ms).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
      });
    },
  };
  deps = { ...deps, cesFetch: runFetch, judgeFetch: runJudgeFetch, judgeRetry,
    lifecycle: lifecycle(deps) };
  try {
    const { _run_signal: _signal, ...storedConfig } = config;
    if (!deps.db.getRun(jobId)) deps.db.createRun({
      job_id: jobId,
      org_id: (config.org_id as string) ?? "",
      user_id: (config.user as string) ?? "",
      ai_feature: (config.ai_feature as string) ?? "",
      runner_name: (config.runner as string) ?? "",
      config: storedConfig,
    });
    const executionId = deps.lifecycle!.begin(jobId);
    if (!executionId) return;
    deps = { ...deps, executionId };
    await runNlqEval(deps, jobId, config);
  } catch (e) {
    if (!authorized(deps, jobId) || controller.signal.aborted || getControl(deps, jobId) === "cancel" || !deps.db.getRun(jobId)) return;
    const msg = friendlyFailure(e);
    deps.log?.(`NLQ eval job ${jobId} failed`, e);
    writeState(deps, jobId, { status: "failed", error: msg });
    spub(deps, jobId, { type: "error", error: msg });
    spub(deps, jobId, { type: "done", status: "failed" });
  } finally {
    if (deps.runControllers?.get(jobId) === controller) deps.runControllers.delete(jobId);
  }
}
