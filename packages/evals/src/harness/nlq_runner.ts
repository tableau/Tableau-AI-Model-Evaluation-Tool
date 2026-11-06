/**
 * Native TypeScript HarnessRunner — the real NLQ evaluation loop that runs
 * suite cases against a Tableau CES server and scores them with the metrics
 * engine.
 *
 * This is the pluggable `HarnessRunner` seam that `src/adapters/nlq.ts` leaves
 * injectable. It uses explicit paths and credentials:
 *   - loadConversations() reads case JSON from `config.test_path` (the suite's
 *     resolved case dir; the routes layer sets it from the catalog).
 *   - runCase() posts to the CES `conversations` endpoint via a per-run
 *     {@link TableauSession} (built from the merged RunConfig at runtime — NO
 *     import-time credential coupling), parses the per-stage `actual` shape the
 *     runner expects (recursive traversal), and scores each
 *     stage's metrics through the `computeMetric` registry + viz metrics
 *     + calc validator.
 *
 * ## Which CES endpoint (bridge vs direct)
 *
 * The embedded {@link CesBridge} (src/bridge/ces.ts) forwards to the PROMPT-based
 * `/analytics-assistant/v1/generations` endpoint — the chat-completion vehicle
 * used by the BYOLLM gateway path. This runner instead posts a
 * STRUCTURED payload to `/analytics-assistant/conversations` and reads back
 * `intentApplicationDetection.result.{intent,calculatedFieldFormula,
 * notionalSpec,steps}`. That is a different wire contract, so the runner calls
 * session + fetch DIRECTLY rather than through the
 * bridge. Auth is `X-Tableau-Auth` from the shared TableauSession.
 *
 * ## Rate limit
 *
 * global.json caps traffic at `maxRequestRate` (2) requests per `limitSeconds`
 * (10). We enforce it with a tiny async sliding-window limiter shared across a
 * run.
 *
 * ## Fully wired vs deferred
 *
 * FULLY WIRED (ect-server path — calcs, viz-authoring, multistep):
 *   - conversations POST + per-utterance conversation history threading,
 *   - per-stage `actual` extraction (intent / calculatedFieldFormula /
 *     notionalSpec / steps),
 *   - deterministic scoring: Equals, Calc* (validity/field/value), Spec*
 *     (field validity/accuracy), plus the tool's viz-quality metrics on notional
 *     specs. LLM-judge metrics are attached separately by the orchestrator.
 *
 * DEFERRED (flagged as TODO, non-blocking):
 *   - narrative NER metrics (DashboardNarrativeNumerical*): tolerance-relaxed
 *     spaCy substitute path, attached elsewhere. Not emitted here.
 *
 * CONTEXT METRICS (SemanticSearchAccuracy / SpecSemanticSearchAccuracy /
 * FieldRankScorer): these read `_context.opensearch_query.matched` which the
 * live ect-server currently returns EMPTY, so they score trivially (1.0 /
 * empty) on real traffic. They ARE wired into the deterministic scoring path
 * (metrics_file="metrics") and golden-tested
 * (goldens/context_metrics). `_context` is captured off the live response
 * BEFORE buildHistoryElement strips it from the threaded history.
 *
 * ## Datasource indexing (prepare)
 *
 * A CES conversation only generates a calc formula / notional spec when the
 * target datasource has been INDEXED for the site — otherwise CES answers with
 * `result.status = "NOT_PERFORMED"` and an empty
 * `calculatedFieldFormula {formula:"",caption:"",type:""}` plus a
 * "the datasource contains no fields" reply. `prepare()` therefore uploads the
 * datasource fixture metadata (POST datasources → capture datasourceECTId →
 * POST fields with the field value samples) once per datasource (idempotent via an
 * `_indexed` set). The captured `datasourceECTId` is then threaded into the
 * conversation payload. The index endpoints negotiate the datasources v1
 * content type (a plain application/json Accept is refused with HTTP 406).
 */

import { join } from "node:path";
import { contentIsDir, contentReaddir, contentReadText } from "@tableau-ai-eval/core";

import type {
  HarnessCase,
  HarnessCaseResult,
  HarnessConversation,
  HarnessRunner,
} from "../adapters/nlq.ts";
import type { MetricEntry, RowError, RunConfig } from "@tableau-ai-eval/core";
import { TableauAuthError, TableauSession, type FetchLike } from "@tableau-ai-eval/core";
import { sessionFromRunConfig, connectionKey as coreConnectionKey, sharedSession } from "@tableau-ai-eval/core";
import { tlsInit } from "@tableau-ai-eval/core";
import {
  computeMetric,
  type ComputedMetric,
  type MetricContext,
} from "../metrics/classes.ts";
import { computeToolMetrics, NO_EXPECTED_CHART_WARNING, UNCHANGED_CHART_KEY, VIZ_STAGE } from "../metrics/viz.ts";
import { tokenize, TokenType } from "../validator/lexer.ts";
import { normalizeFormula } from "../validator/tableau_validator.ts";
import { getMetricsConfig, type MetricConfigEntry } from "./metrics_config.ts";
import { NARRATIVE_RUNNER, NARRATIVE_PATH, NARRATIVE_HEADERS, narrativePayload } from "./narrative_request.ts";
import { narrativeGroundTruths } from "@tableau-ai-eval/core";
import { computeNarrativeMetricsAsync } from "../metrics/narrative_pool.ts";

// ---------------------------------------------------------------------------
// Request and retry defaults.
// ---------------------------------------------------------------------------

/** ect-server.json `endpoint_mappings.conversations`, relative to ces_url. */
const CES_CONVERSATIONS_PATH = "/analytics-assistant/conversations";

/** ect-server.json `endpoint_mappings.datasources`, relative to ces_url. */
const CES_DATASOURCES_PATH = "/analytics-assistant/datasources";
/**
 * The keys of a field in the datasource metadata the server registers (its
 * `DatasourceStaticMetadataDTO.DatasourceField`). Since the server's
 * 2026-10-30 build (a Spring upgrade) request parsing rejects any other key
 * with HTTP 400 "There was a problem parsing the request", so the fixtures'
 * sample statistics (`count`, `distinctCount`, `values`, date bounds) stay
 * out of this body: the value samples go in the fields call, whose model
 * declares them.
 */
const STATIC_FIELD_KEYS = new Set([
  "name", "caption", "familyName", "description", "role", "type", "datatype",
  "defaultAggregation", "tooltipText", "lastUpdated", "formula", "embedding",
]);
function staticField(field: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(field).filter(([key]) => STATIC_FIELD_KEYS.has(key)));
}

/**
 * color-palettes-server.json `endpoint_mappings.generate`, relative to ces_url.
 * The palette runner posts a `{utterance, paletteType}` body here and gets back
 * `{colors: [...]}`.
 */
const CES_COLOR_PALETTES_PATH = "/analytics-assistant/color-palettes/generate";

/**
 * headers.json `datasources` block. The datasources/fields index endpoints
 * negotiate a DIFFERENT content type than conversations (a plain
 * `application/json` Accept is rejected with HTTP 406 Not Acceptable), so the
 * `prepare()` index round-trip must send the datasources v1 Accept header.
 */
const DATASOURCES_HEADERS: Record<string, string> = {
  Accept: "application/vnd.analytics-assistant.datasources.v1.0+json",
  "Content-Type": "application/json",
  "Accept-Charset": "UTF-8",
};

/**
 * headers.json `conversations` block. The Accept header selects the v4
 * conversations contract that returns intentApplicationDetection.
 */
const CONVERSATIONS_HEADERS: Record<string, string> = {
  Accept: "application/vnd.analytics-assistant.conversations.v4.0+json",
  "Content-Type": "application/json",
  "Accept-Charset": "UTF-8",
};

/**
 * headers.json `colorPalettes` block. The palette generate endpoint negotiates
 * its own v1 content type.
 */
const COLOR_PALETTES_HEADERS: Record<string, string> = {
  Accept: "application/vnd.analytics-assistant.color-palettes.v1.0+json",
  "Content-Type": "application/json",
};

/** requests/tableau/conversations.json request template. */
function conversationsTemplate(): Record<string, unknown> {
  return {
    intentApplicationAccepts: null,
    utterance: { content: "" },
    conversationContext: { conversationHistory: [] },
    currentNotionalSpec: { version: "0.2.0", fields: [] },
    // The keys of the server's CalculationContextDTOv2. The evaluator's
    // template also sent `errorPosition: 0`, a key that model never declared;
    // since the server's 2026-10-30 build that is HTTP 400 "There was a
    // problem parsing the request".
    applicationContext: {
      calculationContext: {
        formula: null,
        caption: "",
        errorMessages: [],
      },
    },
  };
}

/** global.json rate limit: maxRequestRate requests per limitSeconds window. */
const MAX_REQUEST_RATE = 2;
const LIMIT_SECONDS = 10;

/** ect-server.json retryOn + 5xx are transient (mirrors http_runner). */
const RETRY_ON = new Set([429]);
const MAX_ATTEMPTS = 3;
/**
 * How long one request may go unanswered before it is given up on and tried
 * again. Two minutes is the limit the WAII client and the tool's own bridge
 * use against the same server, and more than twice the slowest answer on
 * record for these endpoints. `TABLEAU_AI_EVAL_REQUEST_TIMEOUT` (seconds;
 * `TABLEAU_AI_EVAL_REQUEST_TIMEOUT`, the public name) overrides it
 * for a slow model gateway.
 */
export const DEFAULT_REQUEST_TIMEOUT_S = 120;
export const REQUEST_TIMEOUT_ENV = "TABLEAU_AI_EVAL_REQUEST_TIMEOUT";

/** Seconds one request may take; a positive `TABLEAU_AI_EVAL_REQUEST_TIMEOUT` overrides. */
export function requestTimeoutS(): number {
  const raw = process.env[REQUEST_TIMEOUT_ENV];
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_REQUEST_TIMEOUT_S;
}

/** True for the error an `AbortSignal.timeout` raises (or a fetch timeout). */
function isTimeoutError(exc: unknown): boolean {
  const name = (exc as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || (exc as { code?: unknown } | null)?.code === "ETIMEDOUT";
}

// ---------------------------------------------------------------------------
// First value at `key` anywhere in the tree.
// ---------------------------------------------------------------------------

/** Depth-first search for the first occurrence of `key`. Mirrors find_sub_entry. */
export function findSubEntry(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    // Only objects are descended; arrays are not searched.
    return null;
  }
  const rec = obj as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, key)) {
    return rec[key];
  }
  for (const v of Object.values(rec)) {
    const found = findSubEntry(v, key);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse a calculation formula using the shared lexer.
// ---------------------------------------------------------------------------

/**
 * Date parts are syntax, not data: DATEPART('month', …) names a part of a
 * date, so 'month' is not a value the formula compares or returns.
 */
const DATE_PARTS = new Set([
  "year",
  "quarter",
  "month",
  "dayofyear",
  "day",
  "weekday",
  "week",
  "hour",
  "minute",
  "second",
  "iso-year",
  "iso-quarter",
  "iso-week",
  "iso-weekday",
]);

/**
 * A literal as the value metrics compare it: a
 * string without its quotes, ignoring case (`s:` prefix); a number as a number,
 * so 0.90 is 0.9 (`n:` prefix). Null for a date part.
 */
export function normalizeValue(text: string): string | null {
  const first = text.slice(0, 1);
  if (first === "'" || first === '"') {
    const inner = text.slice(1, -1).split(first + first).join(first);
    if (DATE_PARTS.has(inner.trim().toLowerCase())) return null;
    return "s:" + inner.toLowerCase();
  }
  const number = Number(text);
  if (text.trim() === "" || Number.isNaN(number)) return "s:" + text.toLowerCase();
  return "n:" + (Number.isInteger(number) ? BigInt(number).toString() : String(number));
}

/**
 * Extract (fields, values) from a Tableau calc formula the way the ANTLR
 * `ParseCalcsFormula` visitor does:
 *   - fields  = FIELDNAME tokens, stripped of brackets and whitespace,
 *   - values  = string and number literals, normalised by `normalizeValue`
 *               (date parts left out),
 *   - valueText = the literal as written, per normalised value (first seen),
 *               for explanations.
 * De-duplicated.
 */
export function parseCalcsFormula(formula: string | null | undefined): {
  fields: string[];
  values: string[];
  valueText: Record<string, string>;
} {
  const fields = new Set<string>();
  const values = new Set<string>();
  const valueText: Record<string, string> = {};
  const text = normalizeFormula(formula);
  if (!text) return { fields: [], values: [], valueText };
  let tokens: ReturnType<typeof tokenize>;
  try {
    tokens = tokenize(text);
  } catch {
    // A formula the lexer can't tokenize yields no fields/values (the
    // caller treats an unparseable formula as empty).
    return { fields: [], values: [], valueText };
  }
  for (const tok of tokens) {
    if (tok.type === TokenType.FIELDNAME) {
      // getText().strip('[]').strip() — FIELDNAME text is like "[Sales]".
      const name = tok.text.replace(/^\[+/, "").replace(/\]+$/, "").trim();
      if (name) fields.add(name);
    } else if (
      tok.type === TokenType.STRINGLITERAL ||
      tok.type === TokenType.INTEGERLITERAL ||
      tok.type === TokenType.DOUBLELITERAL
    ) {
      const key = normalizeValue(tok.text);
      if (key !== null) {
        values.add(key);
        if (!(key in valueText)) valueText[key] = tok.text;
      }
    }
  }
  return { fields: [...fields], values: [...values], valueText };
}

// ---------------------------------------------------------------------------
// Sliding-window rate limiter (global.json).
// ---------------------------------------------------------------------------

/**
 * Allow at most `rate` acquisitions per `windowMs`. `acquire()` resolves once a
 * slot is free, sleeping the minimum time otherwise. Single-threaded, so no
 * lock needed — just a timestamp ring.
 */
export class RateLimiter {
  private readonly _rate: number;
  private readonly _windowMs: number;
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _now: () => number;
  private _timestamps: number[] = [];

  constructor(opts: {
    rate?: number;
    windowMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {}) {
    this._rate = opts.rate ?? MAX_REQUEST_RATE;
    this._windowMs = opts.windowMs ?? LIMIT_SECONDS * 1000;
    this._sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._now = opts.now ?? (() => Date.now());
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      signal?.throwIfAborted();
      const now = this._now();
      const cutoff = now - this._windowMs;
      this._timestamps = this._timestamps.filter((t) => t > cutoff);
      if (this._timestamps.length < this._rate) {
        this._timestamps.push(now);
        return;
      }
      // Wait until the oldest timestamp exits the window.
      const oldest = this._timestamps[0];
      const wait = Math.max(0, oldest + this._windowMs - now);
      if (!signal) await this._sleep(wait);
      else await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        this._sleep(wait).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Suite loading
// ---------------------------------------------------------------------------

/** Raw JSON case-file shape. */
interface CaseFile {
  id?: string;
  runner?: string;
  datasource?: string | number | null;
  info?: Record<string, unknown>;
  inputs?: Array<{
    utterance?: string;
    source?: string;
    arguments?: Record<string, unknown> | null;
    expected?: Record<string, unknown> | null;
    tags?: string[];
    labels?: Record<string, unknown>;
    is_supported?: boolean;
  }>;
}

/** Recursively collect *.json case files under a suite dir. */
function collectCaseFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = contentReaddir(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(d, name);
      if (contentIsDir(full)) walk(full);
      else if (name.endsWith(".json")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Build a conversation (ordered HarnessCase[]) from one case file. Mirrors
 * `load_test_cases`: each `inputs` entry is a turn; the id is uniquified with
 * `:i` only when there are follow-ups (len(inputs) > 1).
 */
export function conversationFromFile(doc: CaseFile): HarnessConversation {
  const inputs = Array.isArray(doc.inputs) ? doc.inputs : [];
  const baseId = doc.id ?? "";
  const hasFollowUps = inputs.length > 1;
  const runner = doc.runner ?? "";
  const datasource = doc.datasource === null || doc.datasource === undefined ? null : String(doc.datasource);
  const conv: HarnessConversation = [];
  inputs.forEach((input, i) => {
    const paletteTypeVal = input.arguments?.palette_type;
    conv.push({
      id: hasFollowUps ? `${baseId}:${i}` : baseId,
      runner,
      datasource,
      utterance: runner === NARRATIVE_RUNNER
        ? `Dashboard Name: ${input.arguments?.dashboardName ?? ""}`
        : input.utterance ?? "",
      turn: i,
      expected: input.expected ?? {},
      paletteType: typeof paletteTypeVal === "string" ? paletteTypeVal : null,
      arguments: input.arguments,
      isEnd: i === inputs.length - 1,
    });
  });
  return conv;
}

/** Resolve the suite case dir from config. `test_path` wins; else null. */
function resolveSuiteDir(config: RunConfig): string | null {
  const testPath = config.test_path;
  if (typeof testPath === "string" && testPath.trim()) return testPath.trim();
  return null;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface NlqHarnessRunnerOptions {
  /** Injectable fetch (defaults to global). Tests inject a canned responder. */
  fetchImpl?: FetchLike;
  /** Injectable TableauSession factory (defaults to real per-run session). */
  sessionFactory?: (config: RunConfig) => TableauSession | null;
  /** Injectable rate limiter (tests use a no-wait one). */
  rateLimiter?: RateLimiter;
  /**
   * Datasource fixtures loader: datasource id → {fields:[{caption,datatype}]}.
   * Defaults to reading `<fixturesDir>/<id>.json` when `config.fixtures_dir` is
   * set. Field-validity metrics degrade gracefully when unavailable.
   */
  loadDatasource?: (config: RunConfig, datasource: string) => DatasourceFixture | null;
  /**
   * Full datasource metadata loader (for indexing / `prepare()`): datasource
   * id → the raw `datasourceMetadata` object CES expects (name, fields with
   * value samples, etc). Defaults to reading `<fixturesDir>/<id>.json`. When it
   * returns null the datasource is NOT indexed (the case then surfaces the CES
   * "no fields" reply rather than a real formula).
   */
  loadDatasourceMetadata?: (config: RunConfig, datasource: string) => DatasourceMetadata | null;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface DatasourceFixture {
  fields: Array<{ caption: string; datatype?: string; dataType?: string }>;
}

/** Raw datasource metadata as CES `POST /datasources` expects it. */
export interface DatasourceMetadata {
  datasourceIdentifier?: string;
  name?: string;
  fields: Array<Record<string, unknown>>;
}

/** Actual per-stage shape produced by the runner (mirrors TestResult.actual). */
type ActualShape = Record<string, unknown>;

export class NlqHarnessRunner implements HarnessRunner {
  private readonly _fetch: FetchLike;
  private readonly _sessionFactory: (config: RunConfig) => TableauSession | null;
  private readonly _rateLimiter: RateLimiter;
  private readonly _loadDatasource: (config: RunConfig, datasource: string) => DatasourceFixture | null;
  private readonly _loadDatasourceMetadata: (
    config: RunConfig,
    datasource: string,
  ) => DatasourceMetadata | null;
  private readonly _log?: (msg: string) => void;

  /** Per-run session cache, keyed by connection identity. */
  private _session: TableauSession | null = null;
  private _sessionKey: string | null = null;
  /** Conversation-history accumulator, keyed by conversation base id. */
  private readonly _history = new Map<string, unknown[]>();
  /** Datasource fixture cache (get_datasource lru_cache analogue). */
  private readonly _dsCache = new Map<string, DatasourceFixture | null>();
  /** Includes generated fields registered by earlier turns of this run. */
  private readonly _dsDescriptions = new Map<string, DatasourceMetadata>();
  /** Datasource id → CES datasourceECTId (tabagent datasource_id_to_ect_id). */
  private readonly _dsEctId = new Map<string, string>();
  /** Datasource ids already indexed this run (tabagent `indexed` set). */
  private readonly _indexed = new Set<string>();
  /**
   * In-flight `prepare()` promise per datasource. With conversations running
   * concurrently the first case of each datasource may race a sibling into
   * `prepare`; a datasource's registration is not re-entrant, so callers await
   * the same in-flight promise (so a datasource registers once and alone).
   */
  private readonly _preparing = new Map<string, Promise<void>>();

  constructor(opts: NlqHarnessRunnerOptions = {}) {
    this._fetch = opts.fetchImpl ?? fetch;
    this._sessionFactory = opts.sessionFactory ?? ((config) => buildSession(config));
    this._rateLimiter = opts.rateLimiter ?? new RateLimiter();
    this._loadDatasource = opts.loadDatasource ?? defaultLoadDatasource;
    this._loadDatasourceMetadata =
      opts.loadDatasourceMetadata ?? defaultLoadDatasourceMetadata;
    this._log = opts.log;
  }

  // -- loading --------------------------------------------------------------

  loadConversations(config: RunConfig): HarnessConversation[] {
    const dir = resolveSuiteDir(config);
    if (!dir) {
      throw new Error(
        "NLQ harness: no suite directory — config.test_path is required " +
          "(the routes layer resolves it from the selected suite).",
      );
    }
    const files = collectCaseFiles(dir);
    if (files.length === 0) {
      throw new Error(`NLQ harness: no case files found under ${dir}`);
    }
    const conversations: HarnessConversation[] = [];
    for (const file of files) {
      let doc: CaseFile;
      try {
        doc = JSON.parse(contentReadText(file)) as CaseFile;
      } catch {
        this._log?.(`skipping unreadable case file: ${file}`);
        continue;
      }
      const conv = conversationFromFile(doc);
      if (conv.length > 0) conversations.push(conv);
    }
    if (conversations.length === 0) {
      throw new Error(`NLQ harness: no runnable cases parsed under ${dir}`);
    }
    return conversations;
  }

  // -- running --------------------------------------------------------------

  async runCase(
    testCase: HarnessCase,
    config: RunConfig,
    prefixes: string[],
  ): Promise<HarnessCaseResult> {
    const errors: RowError[] = [];
    const utterance = [...prefixes, testCase.utterance].filter((p) => p).join(" ");
    // Conversation base id groups turns; strip the ":i" suffix if present.
    const convId = testCase.id.includes(":") ? testCase.id.split(":")[0]! : testCase.id;
    const history = this._history.get(convId) ?? [];

    const cesUrl = String(config.ces_url ?? "").replace(/\/+$/, "");
    if (!cesUrl) {
      errors.push(runError("NLQ harness: config.ces_url is required for the ect-server runner"));
      return { actual: {}, latency: null, errors, metrics: {} };
    }

    // Colour-palette runner: a separate endpoint and
    // request shape — POST {utterance, paletteType} to
    // /analytics-assistant/color-palettes/generate, get back {colors}. No
    // datasource indexing, no conversation history, no notionalSpec carry. The
    // response maps to {colorPalette: colors} so the shared evaluate()/scoring
    // path (colorPalette stage) and the orchestrator palette judge take over.
    if (testCase.runner === "color-palettes-server") {
      return this.runPaletteCase(testCase, config, utterance, errors);
    }

    // Index the datasource for the site before the first case that uses it
    // (tabagent prepare()). CES only generates a formula/spec against an
    // indexed datasource — otherwise it returns status=NOT_PERFORMED and an
    // empty calculatedFieldFormula. Idempotent per datasource (`_indexed`).
    const narrative = testCase.runner === NARRATIVE_RUNNER;
    if (!narrative && testCase.datasource) {
      try {
        await this.prepare(cesUrl, testCase.datasource, config);
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc);
        // Non-fatal: surface as a warning-ish error, still run the case (CES
        // will report "no fields" if indexing truly failed).
        errors.push(runError(`datasource indexing failed for ${testCase.datasource}: ${msg}`));
      }
    }

    // Build CES conversations payload (tabagent _construct_payload).
    let payload = conversationsTemplate();
    (payload.utterance as Record<string, unknown>).content = utterance;
    // Map datasource id → indexed datasourceECTId when available (tabagent
    // datasource_id_to_ect_id); fall back to the identifier itself.
    payload.datasourceECTId =
      (testCase.datasource && this._dsEctId.get(testCase.datasource)) ??
      testCase.datasource ??
      null;
    (payload.conversationContext as Record<string, unknown>).conversationHistory = history;
    // Carry forward the last notional spec (tabagent behavior).
    const lastSpec = lastNotionalSpec(history);
    if (lastSpec !== null) payload.currentNotionalSpec = lastSpec;
    if (testCase.arguments && "currentNotionalSpec" in testCase.arguments) {
      payload.currentNotionalSpec = testCase.arguments.currentNotionalSpec;
    }

    let response: Record<string, unknown> | null = null;
    let latency: number | null = null;
    const url = `${cesUrl}${narrative ? NARRATIVE_PATH : CES_CONVERSATIONS_PATH}`;
    try {
      if (narrative) payload = narrativePayload(testCase.arguments, undefined,
        config.adapter === "narratives" ? `tableau-ai-eval ${String(config.job_id || "")} ${testCase.id}` : undefined,
      );
      const res = await this._post(url, payload, config, narrative ? NARRATIVE_HEADERS : CONVERSATIONS_HEADERS);
      latency = res.latency;
      if (res.status !== 200) {
        errors.push(runError(`Bad response (${res.status}): ${truncate(res.text, 300)}`));
        return { actual: {}, latency, errors, metrics: {} };
      }
      response = res.json as Record<string, unknown> | null;
    } catch (exc) {
      if (exc instanceof TableauAuthError) {
        errors.push(runError(`Tableau auth failed: ${exc.message}`));
      } else {
        const msg = exc instanceof Error ? exc.message : String(exc);
        errors.push(runError(msg));
      }
      return { actual: {}, latency, errors, metrics: {} };
    }

    // Thread conversation history for the next turn (tabagent _construct_history_element).
    const historyEntry = narrative ? null : buildHistoryElement(response, utterance, testCase);
    if (historyEntry) this._history.set(convId, [...history, historyEntry]);
    // A follow-up may refer to the new calculation: learn its Tableau type
    // and register it before the next turn, as the standalone Agent does.
    if (config.adapter === "agent" && !testCase.isEnd && historyEntry && testCase.datasource) {
      const calc = digPath(historyEntry, ["detection", "result", "calculatedFieldFormula"]);
      if (calc && typeof calc === "object" && (calc as Record<string, unknown>).formula) {
        await this.indexGeneratedCalculation(cesUrl, testCase.datasource, historyEntry, calc as Record<string, unknown>, config);
      }
    }

    // An empty Dashboard summaries answer is a failed case, not an answer:
    // scoring it rated nothing as perfectly readable and concise. The case
    // gets a run error and no answer, so no metric is computed for it (and it
    // is not a transient failure, so the retry pass leaves it alone).
    // Empty summaries fail the case.
    if (testCase.expected && "insightNarrative" in testCase.expected) {
      // Same lookup evaluate() uses for the stage's `actual`.
      const summary = findSubEntry(response, "insightNarrative");
      if (summaryIsEmpty({ insightNarrative: summary ?? null })) {
        errors.push(runError(EMPTY_SUMMARY_ERROR));
        return { actual: {}, latency, errors, metrics: {} };
      }
    }

    // Extract the per-stage `actual` shape (evaluator.evaluate: find_sub_entry
    // per expected key), and score. A scoring/metric exception here must NOT
    // end the run: the answer already exists, only its scoring failed, so keep
    // the answer, record "Scoring failed: …" on this case, and go on. One such
    // exception used to reject the conversation task and re-raise out of the
    // scheduler, killing the whole run with no rows (Color Palettes,
    // Preserve the answered row when scoring fails.
    // `_run_conversation`'s try/except around `evaluate_fn` + `_scoring_error`.
    let actual: ActualShape;
    let metrics: Record<string, MetricEntry[]>;
    try {
      if (narrative) {
        const summary = findSubEntry(response, "insightNarrative");
        actual = { insightNarrative: summary };
        metrics = { insightNarrative: await computeNarrativeMetricsAsync(Array.isArray(testCase.arguments?.views) ? testCase.arguments.views : [], testCase.expected, summary) };
      } else ({ actual, metrics } = this.evaluate(testCase, config, response, errors, lastSpec));
    } catch (exc) {
      const name = exc instanceof Error ? exc.constructor.name : "Error";
      const msg = exc instanceof Error ? exc.message : String(exc);
      this._log?.(`Scoring failed for case ${testCase.id}: ${name}: ${msg}`);
      errors.push(scoringError(`${name}: ${msg}`));
      // Keep the answer: re-extract the per-stage `actual` shape without
      // re-running the metrics (find_sub_entry is defensive and non-throwing).
      actual = {};
      for (const key of Object.keys(testCase.expected ?? {})) {
        actual[key] = findSubEntry(response, key) ?? null;
      }
      metrics = {};
    }

    // user_friendly_reply fold-in (tabagent evaluator_data) so the orchestrator
    // judge can read actual.user_friendly_reply.
    const reply = findSubEntry(response, "response");
    const replyContent =
      reply && typeof reply === "object"
        ? (reply as Record<string, unknown>).content
        : null;
    if (replyContent !== null && replyContent !== undefined) {
      actual.user_friendly_reply = replyContent;
    }

    const debugInfo = extractDebugContext(response) ?? {};
    if (narrative) debugInfo.narrative_truths = narrativeGroundTruths(testCase.arguments?.views);

    // The keys tabagent_runner's `__extract_prompt_data` puts in
    // `evaluator_data` that the row serializer keeps.
    const promptCtx = digPath(response, ["intentApplicationDetection", "result", "_context"]);
    const matchedFields = digPath(promptCtx, ["llm_request", "matched_fields"]);
    const evaluatorData: Record<string, unknown> = {
      scoped_datasource_fields: Array.isArray(matchedFields)
        ? matchedFields.map((f) => ({
            caption: (f as Record<string, unknown>)?.fieldName,
            dataType: (f as Record<string, unknown>)?.dataType,
          }))
        : null,
      semanticsearch_results: extractSemanticSearchResults(response),
    };
    if (testCase.datasource) {
      try {
        evaluatorData.datasource_fields = this.datasourceFields(config, testCase.datasource);
      } catch {
        // Debug-only: a datasource that could not be read already failed scoring above.
      }
    }

    return {
      actual,
      latency,
      errors,
      metrics,
      debugInfo,
      info: { conversationHistory: (this._history.get(convId) ?? []).map(historyUtterance) },
      evaluatorData,
    };
  }

  /**
   * Run one colour-palette case.
   * POSTs `{utterance, paletteType}` to the palette generate endpoint and maps
   * the `{colors}` response to `{colorPalette: colors}`, then scores it through
   * the shared evaluate() path (colorPalette stage). A scoring exception is
   * captured (never re-raised), matching runCase.
   */
  private async runPaletteCase(
    testCase: HarnessCase,
    config: RunConfig,
    utterance: string,
    errors: RowError[],
  ): Promise<HarnessCaseResult> {
    const cesUrl = String(config.ces_url ?? "").replace(/\/+$/, "");
    const url = `${cesUrl}${CES_COLOR_PALETTES_PATH}`;
    // requests/tableau/color-palettes.json: {utterance:{content}, paletteType}.
    const payload: Record<string, unknown> = {
      utterance: { content: utterance },
      paletteType: testCase.paletteType ?? null,
    };

    let response: Record<string, unknown> | null = null;
    let latency: number | null = null;
    try {
      const res = await this._post(url, payload, config, COLOR_PALETTES_HEADERS);
      latency = res.latency;
      if (res.status !== 200) {
        errors.push(runError(`Bad response (${res.status}): ${truncate(res.text, 300)}`));
        return { actual: {}, latency, errors, metrics: {} };
      }
      response = res.json as Record<string, unknown> | null;
    } catch (exc) {
      if (exc instanceof TableauAuthError) {
        errors.push(runError(`Tableau auth failed: ${exc.message}`));
      } else {
        errors.push(runError(exc instanceof Error ? exc.message : String(exc)));
      }
      return { actual: {}, latency, errors, metrics: {} };
    }

    // Map {colors} → {colorPalette: colors} (the runner's return shape) so the
    // colorPalette-stage metrics find the palette via find_sub_entry.
    const colors = response && typeof response === "object" ? (response as Record<string, unknown>).colors : null;
    const mapped: Record<string, unknown> = { colorPalette: colors ?? [] };

    let actual: ActualShape;
    let metrics: Record<string, MetricEntry[]>;
    try {
      ({ actual, metrics } = this.evaluate(testCase, config, mapped, errors));
    } catch (exc) {
      const name = exc instanceof Error ? exc.constructor.name : "Error";
      const msg = exc instanceof Error ? exc.message : String(exc);
      this._log?.(`Scoring failed for palette case ${testCase.id}: ${name}: ${msg}`);
      errors.push(scoringError(`${name}: ${msg}`));
      actual = {};
      for (const key of Object.keys(testCase.expected ?? {})) {
        actual[key] = findSubEntry(mapped, key) ?? null;
      }
      metrics = {};
    }

    return { actual, latency, errors, metrics, debugInfo: null, info: {} };
  }

  // -- scoring --------------------------------------------------------------

  /**
   * For each expected key, pull `actual` from the
   * response (find_sub_entry) and run the configured metrics for that stage.
   * Deterministic metrics only (LLM-judge attached by the orchestrator).
   */
  private evaluate(
    testCase: HarnessCase,
    config: RunConfig,
    response: Record<string, unknown> | null,
    errors: RowError[],
    lastSpec: unknown = null,
  ): { actual: ActualShape; metrics: Record<string, MetricEntry[]> } {
    const actual: ActualShape = {};
    const metrics: Record<string, MetricEntry[]> = {};
    const expected = testCase.expected ?? {};
    const metricsConfig = getMetricsConfig(String(config.metrics_file ?? ""), testCase.runner);
    const datasourceFields = this.datasourceFields(config, testCase.datasource);

    // `data["semanticsearch_results"]`: ect-server _context.opensearch_query.matched.
    // Captured off the live response (the original `response` still carries
    // _context here; buildHistoryElement only strips its own history COPY).
    const semanticsearchResults = extractSemanticSearchResults(response);

    // notionalSpec stage additionally gets the tool's viz-quality metrics.
    const utterance = testCase.utterance;

    for (const key of Object.keys(expected)) {
      const stageConfig = metricsConfig[key];
      const expectedVal = (expected as Record<string, unknown>)[key];
      const actualVal = findSubEntry(response, key);
      actual[key] = actualVal ?? null;

      // A chart request the server answered without a chart definition (the
      // model replied UNCHANGED: nothing to change, an unsupported request,
      // or one it cannot meet) leaves the previous chart on screen, as it
      // does for a user: the row records that chart and is scored on it. An
      // answer with another intent is a wrong answer, not an unchanged chart.
      // Retain the current chart on confirmed no-op responses.
      let carried: Record<string, unknown> | null = null;
      if (
        key === "notionalSpec" && isPlainObject(expectedVal) && !isPlainObject(actualVal) && isPlainObject(lastSpec) &&
        findSubEntry(response, "intent") === (expected as Record<string, unknown>).intent
      ) {
        carried = lastSpec as Record<string, unknown>;
        actual[UNCHANGED_CHART_KEY] = carried;
      }
      const scoredVal = carried ?? actualVal;

      const stageMetrics: MetricEntry[] = [];

      if (stageConfig && stageConfig.length > 0) {
        for (const mc of stageConfig) {
          const computed = this.computeStageMetric(mc, {
            key,
            expected: expectedVal,
            actual: scoredVal,
            utterance,
            datasourceFields,
            semanticsearchResults,
            paletteType: testCase.paletteType ?? null,
          });
          for (const c of computed) stageMetrics.push(toEntry(c));
        }
      } else {
        errors.push(evalError(`No metrics for ${key}`));
      }

      // the tool's viz-quality metrics on the notionalSpec stage. A chart case the
      // suite ships without an expected chart gets a warning instead of
      // scores. The reply
      // (tabagent evaluator_data `user_friendly_reply`) feeds Information
      // Similarity; the case's expected reply, when it has one.
      if (key === "notionalSpec" && !isPlainObject(expectedVal)) {
        errors.push({ phase: "EVALUATE_RESULT", description: NO_EXPECTED_CHART_WARNING, warning: true });
      } else if (key === "notionalSpec") {
        try {
          const replyObj = findSubEntry(response, "response");
          const actualReply =
            replyObj && typeof replyObj === "object"
              ? ((replyObj as Record<string, unknown>).content as string | null | undefined)
              : null;
          const exp = expected as Record<string, unknown>;
          const expectedReply = (exp.userFriendlyReply || exp.user_friendly_reply || null) as string | null;
          const viz = computeToolMetrics(
            { notionalSpec: expectedVal },
            { notionalSpec: actualVal },
            {
              expectedReply: typeof expectedReply === "string" ? expectedReply : null,
              actualReply: typeof actualReply === "string" ? actualReply : null,
              carriedSpec: carried,
            },
          );
          if (viz.length > 0) {
            metrics[VIZ_STAGE] = viz.map((v) => ({
              metric_id: v.metric_id,
              metric_name: v.metric_name,
              score: v.score,
              explanation: v.explanation,
            }));
          }
        } catch (exc) {
          errors.push(evalError(`viz metrics failed: ${exc instanceof Error ? exc.message : exc}`));
        }
      }

      metrics[key] = stageMetrics;
    }

    return { actual, metrics };
  }

  /** Dispatch one metric-config entry to the ported registry. */
  private computeStageMetric(
    mc: MetricConfigEntry,
    inputs: {
      key: string;
      expected: unknown;
      actual: unknown;
      utterance: string;
      datasourceFields: { caption: string; datatype?: string }[];
      semanticsearchResults?: unknown[] | null;
      paletteType?: string | null;
    },
  ): ComputedMetric[] {
    const name = mc.metric;
    // Judge-backed metrics are attached by the orchestrator, not here.
    if (JUDGE_METRICS.has(name)) return [];

    const ctx: MetricContext = {
      utterance: inputs.utterance,
      expected: inputs.expected,
      actual: inputs.actual,
      datasourceFields: inputs.datasourceFields,
      semanticsearchResults: inputs.semanticsearchResults ?? null,
      config: { name: mc.name },
    };

    // Colour-palette metrics read the requested palette type (regular /
    // sequential / diverging) and the generated colors. The colorPalette
    // stage's `actual` value IS the list of hex colors (find_sub_entry on the
    // `colorPalette` key), so thread both onto the context. Thresholds stay at
    // the metric defaults (== byollm_palette_metrics.json).
    if (
      name === "ColorPaletteDistinguishability" ||
      name === "GradientSmoothness" ||
      name === "DivergingPaletteStructure" ||
      name === "GroundTruthColorPaletteEvaluation"
    ) {
      ctx.paletteType = inputs.paletteType ?? undefined;
      ctx.colors = Array.isArray(inputs.actual)
        ? (inputs.actual as unknown[]).filter((c): c is string => typeof c === "string")
        : [];
    }

    // Calc metrics need parsed fields/values from the formula string. For calc
    // stages the expected/actual value is the calculatedFieldFormula object,
    // whose formula string is what ParseCalcsFormula consumes. SemanticSearch/
    // FieldRankScorer are ALSO key="formula" and read parsedExpectedFields.
    if (
      name === "CalcValidity" ||
      name === "CalcFieldValidity" ||
      name === "CalcFieldAccuracy" ||
      name === "CalcValueAccuracy" ||
      name === "SemanticSearchAccuracy" ||
      name === "FieldRankScorer"
    ) {
      const expectedFormula = formulaOf(inputs.expected);
      const actualFormula = formulaOf(inputs.actual);
      const pe = parseCalcsFormula(expectedFormula);
      const pa = parseCalcsFormula(actualFormula);
      ctx.parsedExpectedFields = pe.fields;
      ctx.parsedActualFields = pa.fields;
      // valuePrecision/valueRecall need ground truth: no expected formula, no
      // value metrics.
      ctx.parsedExpectedValues = expectedFormula === null ? undefined : pe.values;
      ctx.parsedActualValues = pa.values;
      ctx.expectedValueText = pe.valueText;
      ctx.actualValueText = pa.valueText;
      // CalcValidity validates the actual formula string directly. The other
      // calc/context metrics read the parsed fields/values above and ignore
      // ctx.actual, so overwriting it is harmless for them.
      ctx.actual = actualFormula;
    }

    try {
      return computeMetric(name, ctx);
    } catch (exc) {
      this._log?.(`metric ${name} failed: ${exc instanceof Error ? exc.message : exc}`);
      return [];
    }
  }

  private async indexGeneratedCalculation(
    cesUrl: string,
    datasource: string,
    history: Record<string, unknown>,
    calc: Record<string, unknown>,
    config: RunConfig,
  ): Promise<void> {
    const ectId = this._dsEctId.get(datasource);
    if (!ectId) return;
    try {
      const payload = conversationsTemplate();
      payload.utterance = { content: "what is tableau data type of this calc field? ANSWER MUST BE ENCLOSED IN @", source: "user" };
      payload.datasourceECTId = ectId;
      payload.conversationContext = { conversationHistory: [history] };
      const context = (payload.applicationContext as Record<string, unknown>).calculationContext as Record<string, unknown>;
      context.caption = calc.caption;
      context.formula = calc.formula;
      const reply = await this._post(`${cesUrl}${CES_CONVERSATIONS_PATH}`, payload, config);
      const description = digPath(reply.json, ["intentApplicationDetection", "result", "calculatedFieldDescription"]);
      const datatype = typeof description === "string" ? /@([^@]+)@/.exec(description)?.[1] : null;
      if (!datatype) return;

      const metadata = this._dsDescriptions.get(datasource) ?? this._loadDatasourceMetadata(config, datasource);
      if (!metadata) return;
      const updated = JSON.parse(JSON.stringify(metadata)) as DatasourceMetadata;
      updated.fields = updated.fields.map(staticField);
      updated.fields.push({ name: String(calc.caption || ""), caption: String(calc.caption || ""), description: String(calc.caption || ""), formula: calc.formula, datatype });
      this._dsDescriptions.set(datasource, updated);
      this._dsCache.set(datasource, { fields: updated.fields.map(field => ({ caption: String(field.caption || ""), datatype: String(field.datatype || "") })) });
      await this._post(`${cesUrl}${CES_DATASOURCES_PATH}/${ectId}`, { datasourceMetadata: updated }, config, DATASOURCES_HEADERS, "PUT");
    } catch (error) {
      // The main answer is still usable; failure to register only affects a
      // later turn, and must not discard the row already answered.
      this._log?.(`Could not register generated field ${String(calc.caption)}: ${String(error)}`);
    }
  }

  private datasourceFields(
    config: RunConfig,
    datasource: string | null | undefined,
  ): { caption: string; datatype?: string }[] {
    if (!datasource) return [];
    let fixture = this._dsCache.get(datasource);
    if (fixture === undefined) {
      fixture = this._loadDatasource(config, datasource);
      this._dsCache.set(datasource, fixture);
    }
    if (!fixture || !Array.isArray(fixture.fields)) return [];
    return fixture.fields.map((f) => ({
      caption: f.caption,
      datatype: f.datatype ?? f.dataType,
    }));
  }

  // -- HTTP -----------------------------------------------------------------

  private session(config: RunConfig): TableauSession | null {
    // Adopt the run's one shared session when the orchestrator registered one,
    // so the runner and the embedded CES bridge sign in with the same PAT
    // token instead of ending each other's session (a PAT allows one live
    // session). Falls back to a per-run session built from the config.
    const shared = sharedSession(config.job_id as string | undefined);
    if (shared) return shared;
    const key = connectionKey(config);
    if (this._session && this._sessionKey === key) return this._session;
    this._session = this._sessionFactory(config);
    this._sessionKey = key;
    return this._session;
  }

  /**
   * Index a datasource for the site so CES can generate against it. Idempotent per datasource via `_indexed`:
   *   1. POST `<ces>/analytics-assistant/datasources` with `{datasourceMetadata}`
   *      → capture `datasourceECTId`,
   *   2. POST `<ces>/analytics-assistant/datasources/<ectId>/fields` with the
   *      field value samples split out of the metadata.
   * The datasources v1 Accept header is required (plain application/json → 406).
   * When the fixture metadata is unavailable the datasource is left unindexed
   * (the case then surfaces the CES "no fields" reply).
   */
  private async prepare(
    cesUrl: string,
    datasource: string,
    config: RunConfig,
  ): Promise<void> {
    if (this._indexed.has(datasource)) return;
    // Coalesce concurrent first-cases of this datasource onto one registration
    // (not re-entrant); later cases await the same in-flight promise.
    const inflight = this._preparing.get(datasource);
    if (inflight) return inflight;
    const p = this._prepareInner(cesUrl, datasource, config).finally(() => {
      this._preparing.delete(datasource);
    });
    this._preparing.set(datasource, p);
    return p;
  }

  private async _prepareInner(
    cesUrl: string,
    datasource: string,
    config: RunConfig,
  ): Promise<void> {
    if (this._indexed.has(datasource)) return;
    const metadata = this._loadDatasourceMetadata(config, datasource);
    if (!metadata || !Array.isArray(metadata.fields)) {
      // No fixture metadata → cannot index. Mark as "attempted" so we do not
      // re-probe every case; pass the identifier straight through downstream.
      this._indexed.add(datasource);
      this._log?.(`no datasource metadata for ${datasource}; skipping index`);
      return;
    }

    // Split value samples out of the metadata into the fields payload
    // (tabagent prepare(): pop "values" from each field, build field_values).
    const fieldValues: Array<Record<string, unknown>> = [];
    for (const field of metadata.fields) {
      const values = field.values;
      if (Array.isArray(values)) {
        fieldValues.push({
          name: field.name,
          caption: field.caption,
          datatype: field.datatype,
          count: values.length,
          distinctCount: new Set(values).size,
          values,
        });
      }
    }
    const dsMetadata: DatasourceMetadata = { ...metadata, fields: metadata.fields.map(staticField) };

    const dsUrl = `${cesUrl}${CES_DATASOURCES_PATH}`;
    const dsRes = await this._post(dsUrl, { datasourceMetadata: dsMetadata }, config, DATASOURCES_HEADERS);
    if (dsRes.status !== 200) {
      throw new Error(`POST datasources returned ${dsRes.status}: ${truncate(dsRes.text, 200)}`);
    }
    const ectId =
      (dsRes.json && typeof dsRes.json === "object"
        ? (dsRes.json as Record<string, unknown>).datasourceECTId
        : null) ?? datasource;
    this._dsEctId.set(datasource, String(ectId));

    const fieldsUrl = `${dsUrl}/${encodeURIComponent(String(ectId))}/fields`;
    const fRes = await this._post(
      fieldsUrl,
      { datasourceIdentifier: ectId, fields: fieldValues },
      config,
      DATASOURCES_HEADERS,
    );
    if (fRes.status !== 200) {
      // The datasource is registered (ectId captured) even if the field-value
      // index call fails; log but do not hard-fail — CES can still resolve
      // captions from the datasource metadata.
      this._log?.(`POST fields returned ${fRes.status} for ${datasource}`);
    }
    this._indexed.add(datasource);
  }

  /**
   * POST with bounded retries + reactive 401 re-auth (http_runner parity) and
   * the global rate limit. Returns status/text/json/latency; never throws for
   * HTTP status codes (only network/auth propagate). `baseHeaders` selects the
   * content negotiation (conversations v4 vs datasources v1).
   */
  private async _post(
    url: string,
    payload: Record<string, unknown>,
    config: RunConfig,
    baseHeaders: Record<string, string> = CONVERSATIONS_HEADERS,
    method = "POST",
  ): Promise<{ status: number; text: string; json: unknown; latency: number }> {
    const session = this.session(config);
    const verify = (config.verify_tls as boolean) ?? true;
    const caBundlePath = config.ca_bundle_path as string | undefined;
    // Resolve the TLS fragment once per run (verify/caBundlePath are constant);
    // Bun.file() is otherwise re-opened on every attempt of every case.
    const tls = tlsInit({ verify, caBundlePath });
    let reauthed = false;
    let lastText = "";
    let lastStatus = 0;
    let lastLatency = 0;
    const timeoutS = requestTimeoutS();
    const runSignal = config._run_signal as AbortSignal | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this._rateLimiter.acquire(runSignal);
      const headers: Record<string, string> = { ...baseHeaders };
      let sentToken: string | null = null;
      if (session) {
        try {
          sentToken = await session.getToken();
          headers["X-Tableau-Auth"] = sentToken;
        } catch (exc) {
          if (exc instanceof TableauAuthError) throw exc;
          throw exc;
        }
      }
      const init: RequestInit & { tls?: unknown } = {
        method,
        headers,
        body: JSON.stringify(payload),
        signal: runSignal
          ? AbortSignal.any([runSignal, AbortSignal.timeout(timeoutS * 1000)])
          : AbortSignal.timeout(timeoutS * 1000),
        ...tls,
      };

      const start = Date.now();
      let resp: Response;
      try {
        resp = await this._fetch(url, init);
      } catch (exc) {
        runSignal?.throwIfAborted();
        // Network error — transient, retry.
        lastLatency = (Date.now() - start) / 1000;
        lastStatus = 0;
        lastText = isTimeoutError(exc)
          ? `network error: no answer from the server within ${timeoutS} s`
          : `network error: ${exc instanceof Error ? exc.message : String(exc)}`;
        if (attempt >= MAX_ATTEMPTS) break;
        continue;
      }
      lastLatency = (Date.now() - start) / 1000;
      lastStatus = resp.status;

      if (resp.status === 200) {
        let json: unknown = null;
        try {
          json = await resp.json();
        } catch {
          json = null;
        }
        return { status: 200, text: "", json, latency: lastLatency };
      }

      // Reactive 401: re-sign in once for this lost token (concurrent
      // requests that saw the same 401 reuse the new token), then retry once.
      if (resp.status === 401 && session && !reauthed) {
        reauthed = true;
        try {
          await session.handle401(sentToken);
          continue;
        } catch (exc) {
          if (exc instanceof TableauAuthError) throw exc;
          lastText = `re-signin after 401 failed: ${exc instanceof Error ? exc.message : exc}`;
          break;
        }
      }

      lastText = await resp.text().catch(() => "");
      const transient = RETRY_ON.has(resp.status) || resp.status >= 500;
      if (!transient || attempt >= MAX_ATTEMPTS) break;
      // No extra backoff sleep — the rate limiter already paces attempts.
    }

    return { status: lastStatus, text: lastText, json: null, latency: lastLatency };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JUDGE_METRICS = new Set([
  "LLMEvaluation",
  "NotionalSpecJudge",
  "CompatibilityCheck",
  "UnsupportedFeaturesIdentified",
  "DashboardNarrativeSemanticFactualityRate",
  // Context-dependent metrics we do not emit (see header TODO(context-metrics)).
  "DashboardNarrativeNumericalRecallRate",
  "DashboardNarrativeNumericalPrecisionRate",
  "ReadabilityScorer",
  "ConcisenessScorer",
  "StepFieldValidity",
  "StepFieldAccuracy",
]);

/** Build a TableauSession from the merged RunConfig (per-run, no import coupling). */
function buildSession(config: RunConfig): TableauSession | null {
  return sessionFromRunConfig(config);
}

/** Stable key for the session cache: server+site+pat name (never the secret). */
function connectionKey(config: RunConfig): string {
  return coreConnectionKey(config);
}

/** Default datasource fixture loader: `<fixtures_dir>/<id>.json`. */
function defaultLoadDatasource(
  config: RunConfig,
  datasource: string,
): DatasourceFixture | null {
  const doc = readFixtureDoc(config, datasource);
  return doc && Array.isArray(doc.fields) ? (doc as unknown as DatasourceFixture) : null;
}

/** Default full-metadata loader for indexing: `<fixtures_dir>/<id>.json`. */
function defaultLoadDatasourceMetadata(
  config: RunConfig,
  datasource: string,
): DatasourceMetadata | null {
  const doc = readFixtureDoc(config, datasource);
  return doc && Array.isArray(doc.fields) ? (doc as unknown as DatasourceMetadata) : null;
}

/**
 * Read `<fixtures_dir>/<id>.json`. `fixtures_dir` defaults to the sibling
 * `fixtures/` dir of the suite (test_path is `.../<suite>/cases`; fixtures live
 * at `.../fixtures`) so the public pack indexes without extra config.
 */
function readFixtureDoc(
  config: RunConfig,
  datasource: string,
): Record<string, unknown> | null {
  const dir = resolveFixturesDir(config);
  if (!dir) return null;
  try {
    const raw = contentReadText(join(dir, `${datasource}.json`));
    const doc = JSON.parse(raw) as Record<string, unknown>;
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the fixtures dir: explicit `fixtures_dir`, else sibling of test_path.
 * Exported for tests (pure path resolver).
 */
export function resolveFixturesDir(config: RunConfig): string | null {
  const explicit = config.fixtures_dir;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const testPath = config.test_path;
  if (typeof testPath === "string" && testPath.trim()) {
    // test_path = <suite-root>/<...>/cases  →  <suite-root>/fixtures.
    // Walk up until we find a fixtures dir holding `<id>.json`. Two layouts:
    //   - public pack:  <suite-root>/fixtures/<id>.json         (sibling dir)
    //   - nested fixtures: <root>/fixtures/table/<id>.json
    // Prefer `fixtures/table` when present (submodule), else bare `fixtures`.
    let cur = testPath.trim().replace(/\/+$/, "");
    for (let i = 0; i < 5 && cur; i++) {
      const fixtures = join(cur, "fixtures");
      const table = join(fixtures, "table");
      if (contentIsDir(table)) return table;
      if (contentIsDir(fixtures)) return fixtures;
      const parent = join(cur, "..");
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

/** The formula string out of a calculatedFieldFormula value (or the value itself). */
function formulaOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const f = (value as Record<string, unknown>).formula;
    if (typeof f === "string") return f;
  }
  return null;
}

/** Last notionalSpec in the conversation history (tabagent carry-forward). */
function lastNotionalSpec(history: unknown[]): unknown {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const spec = digPath(entry, ["detection", "result", "notionalSpec"]);
    if (spec !== null && spec !== undefined) return spec;
  }
  return null;
}

/** tabagent _construct_history_element: rename intentApplicationDetection→detection. */
function buildHistoryElement(
  response: Record<string, unknown> | null,
  utterance: string,
  _testCase: HarnessCase,
): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const detection = response.intentApplicationDetection;
  if (detection === undefined) return null;
  const entry: Record<string, unknown> = { ...response };
  delete entry.intentApplicationDetection;
  // deep-copy detection and strip _context.
  const det = JSON.parse(JSON.stringify(detection ?? {})) as Record<string, unknown>;
  if (det.result && typeof det.result === "object") {
    delete (det.result as Record<string, unknown>)._context;
  }
  entry.detection = det;
  entry.utterance = { content: utterance, source: "user" };
  return entry;
}

function historyUtterance(entry: unknown): unknown {
  const u = digPath(entry, ["utterance", "content"]);
  return u ?? "";
}

/** intentApplicationDetection.result._context, for debug_info. */
function extractDebugContext(
  response: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const ctx = digPath(response, ["intentApplicationDetection", "result", "_context"]);
  return ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : null;
}

/**
 * `data["semanticsearch_results"]` = the ect-server
 * `_context.opensearch_query.matched` list. Consumed by the SemanticSearchAccuracy /
 * SpecSemanticSearchAccuracy / FieldRankScorer context metrics. Captured
 * BEFORE `buildHistoryElement` strips `_context` off the threaded history.
 * On the live server `_context` is empty so this is null in practice — these
 * metrics are golden-tested, not live-verified.
 */
function extractSemanticSearchResults(
  response: Record<string, unknown> | null,
): unknown[] | null {
  const matched = digPath(response, [
    "intentApplicationDetection",
    "result",
    "_context",
    "opensearch_query",
    "matched",
  ]);
  return Array.isArray(matched) ? matched : null;
}

/** Safe nested get. */
function digPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur ?? null;
}

function toEntry(c: ComputedMetric): MetricEntry {
  return {
    metric_id: c.metric_id,
    metric_name: c.metric_name,
    score: c.score,
    explanation: c.explanation ?? null,
  };
}

function runError(description: string): RowError {
  return { phase: "RUN_TEST", description, warning: false };
}

export const EMPTY_SUMMARY_ERROR =
  "The server returned an empty summary for this dashboard, so there is " +
  "nothing to score.";

/** Whether a summary document holds any words at all. */
function hasText(node: unknown): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  if (Array.isArray(node)) return node.some(hasText);
  if (node !== null && typeof node === "object") return Object.values(node).some(hasText);
  return false;
}

/**
 * True for a Dashboard summaries answer with no words in it: no summary, blank
 * text, or a summary document without content such as `{"sections": []}`.
 * Plain text and anything else is an answer.
 */
export function summaryIsEmpty(actual: unknown): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  if (!("insightNarrative" in actual)) return false;
  let summary: unknown = (actual as Record<string, unknown>).insightNarrative;
  if (summary === null || summary === undefined) return true;
  if (typeof summary === "string") {
    if (!summary.trim()) return true;
    try {
      summary = JSON.parse(summary);
    } catch {
      return false;
    }
  }
  return !hasText(summary);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function evalError(description: string): RowError {
  return { phase: "EVALUATE_RESULT", description, warning: false };
}

/**
 * A harness error for a metric-stage exception.
 * Scoring error: the answer exists, only the
 * scoring failed, so the case says why it has no metrics ("Scoring failed:
 * <Type>: <msg>") and the run goes on.
 */
function scoringError(detail: string): RowError {
  return { phase: "EVALUATE_RESULT", description: `Scoring failed: ${detail}`, warning: false };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
