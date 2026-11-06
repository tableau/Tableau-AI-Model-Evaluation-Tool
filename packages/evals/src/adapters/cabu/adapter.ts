/**
 * CABU (Dashboard Q&A) harness adapter.
 * Tool-side contract wiring.
 *
 * Runs the CABU evaluation through the tool's runner-adapter contract: the
 * client (`../cabu/client.ts`) drives the three-phase CABU product API,
 * and the judge (`../cabu/judge.ts`) scores answers into the `llmJudge`
 * stage.
 *
 * ## Decoupling notes
 *
 * The client is self-contained. Its injectable seams are:
 *   - suite loading (`loadCases`) is injectable (custom suite YAML may live
 *     in a custom folder; the loader parses it, tests inject cases directly);
 *   - the client is injectable (`clientFactory`) so tests drive it with a fake
 *     fetch and no live calls;
 *   - the judge caller is injectable (`judgeCaller`), same as `judge.ts`.
 *
 * Supported behavior:
 *   - LUID resolution (run-config overrides the YAML PLACEHOLDER/env-key
 *     indirection); throwing at load when workbook/datasource LUIDs are missing;
 *   - the three-phase per-case run (create → post → stream) + multi-turn
 *     follow-ups riding in debug_info;
 *   - bounded independent conversations (default three), ordered follow-ups;
 *   - completion-order 401/403 circuit breaker (3 in a row stops dispatch);
 *   - result-row normalization (`serializeCase`), incl. the outputType metric
 *     and judge-entry attachment;
 *   - resume/skip via `completedIds` (single-case conversations) and
 *     `shouldStop()` at case boundaries.
 */

import type {
  AdapterSession,
  CaseSkeleton,
  EmitCase,
  EvalAdapter,
  MetricEntry,
  RowError,
  RowPayload,
  RunConfig,
  ShouldStop,
  SuitePlan,
} from "@tableau-ai-eval/core";
import { callJudge, DEFAULT_RETRY_POLICY, redactSecrets, register, sharedSession, resolveMaxConcurrency } from "@tableau-ai-eval/core";
import { CabuHttpError, TabCabuServiceClient } from "./client.ts";
import { createCabuSuiteLoader, createCabuClientFactory } from "../../harness/cabu_runner.ts";
import { computeCabuJudgeMetrics, type CabuJudgeConfig, type JudgeCaller, rowsKnown } from "./judge.ts";

export const RUNNER_NAME = "cabu-dashboard-qa";
const DEBUG_TEXT_CAP = 4000;
const AUTH_FAILURE_LIMIT = 3;
// Consecutive server-side failures (5xx: the service behind the feature is
// down) before the run stops instead of asking every remaining question.
const SERVICE_FAILURE_LIMIT = 3;
// The server's WAII service limits how often one data source may be indexed,
// and every conversation indexes its data source (on-prem 2026.4: "IndexSdm
// rate limit exceeded for this tenant/SDM"). That is pacing, not a failure: the
// question waits for the limit to clear with these waits, then the last one
// again, up to RATE_LIMIT_MAX_WAIT_MS in all, without using up the retries or
// counting toward the run's breaker.
const RATE_LIMIT_WAITS_MS = [60_000, 120_000, 300_000, 600_000, 900_000];
const RATE_LIMIT_MAX_WAIT_MS = 3_600_000;
const RATE_LIMIT_RE = /rate limit exceeded|RESOURCE_EXHAUSTED/i;

/** The Dashboard Q&A agent sent an error event instead of an answer. */
export class ServerAnsweredWithError extends Error {
  readonly payload: Record<string, unknown>;
  readonly code: string;
  readonly details: string;
  constructor(payload: unknown) {
    const obj =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : { message: String(payload) };
    const code = String(obj.error_code ?? obj.code ?? "").trim();
    const details = String(obj.error_details ?? obj.message ?? obj.error ?? JSON.stringify(obj)).trim();
    super(`${code ? `${code}: ` : ""}${details}`);
    this.name = "ServerAnsweredWithError";
    this.payload = obj;
    this.code = code;
    this.details = details;
  }
}

/** The server's WAII service refused to index the data source again so soon. */
export function isRateLimited(exc: unknown): boolean {
  if (!(exc instanceof CabuHttpError)) return false;
  return exc.status === 429 || RATE_LIMIT_RE.test(exc.body ?? "");
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`;
}

/** Show the judge query rows, not opaque chart tokens. */
export function renderRowsAsMarkdown(rows: unknown, maxRows = 50): string {
  const records = (Array.isArray(rows) ? rows : []).filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))];
  if (!records.length || !columns.length) return "";
  const cell = (value: unknown) =>
    value == null
      ? ""
      : String(value)
          .replace(/\|/g, "\\|")
          .replace(/[\r\n]/g, " ");
  const lines = [
    `| ${columns.map(cell).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...records
      .slice(0, maxRows)
      .map((row) => `| ${columns.map((column) => cell(row[column])).join(" | ")} |`),
  ];
  if (records.length > maxRows) lines.push(`\n_… and ${records.length - maxRows} more rows_`);
  return lines.join("\n");
}

export function answerForJudging(answer: string, rows: unknown): string {
  const table = renderRowsAsMarkdown(rows);
  if (!table) return answer;
  let first = true;
  return answer.replace(/<(?:chart|datatable|table)\d+>/g, () => {
    if (!first) return "";
    first = false;
    return table;
  });
}

/** A parsed CABU suite case: id + the `input` block + tags. */
export interface CabuCase {
  caseId: string;
  input: Record<string, unknown>;
  tags: unknown[];
  /** How the expected answer was computed (public suites): datasource, sql, expect. */
  groundTruth?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LUID resolution
// ---------------------------------------------------------------------------

/** A usable id: not empty, not the suites' PLACEHOLDER marker. */
function real(value: unknown): string {
  const v = String(value ?? "").trim();
  return v === "PLACEHOLDER" ? "" : v;
}

/**
 * Resolve the workbook id and the data sources a case registers.
 *
 * Run-config values win, then non-placeholder YAML values. A suite that asks
 * about several data sources lists them in `datasource_luids` (with optional
 * `datasource_names`, positionally); every other suite names one in
 * `datasource_luid`. The suites ship PLACEHOLDER ids by design and the tool
 * fills them from the content it published (see the server's
 * `dashboard_content`) or from the run request.
 */
export function resolveTargets(
  config: RunConfig,
  inp: Record<string, unknown>,
): { workbookLuid: string; datasources: Record<string, unknown>[] } {
  if (inp._part) {
    const ids = (config._part_ids || {}) as Record<string, Record<string, unknown>>;
    config = { ...config, ...ids[String(inp._part)] };
  }
  const workbookLuid = real(config.workbook_luid) || real(inp.workbook_luid);

  const entries = (luidsIn: unknown, namesIn: unknown): Record<string, unknown>[] => {
    const luids = (Array.isArray(luidsIn) ? luidsIn : []).map(real);
    if (luids.length === 0 || !luids.every((x) => x)) return [];
    const names = Array.isArray(namesIn) ? namesIn : [];
    return luids.map((luid, i) => {
      const entry: Record<string, unknown> = { datasourceLuid: luid };
      const name = i < names.length ? names[i] : null;
      if (name) entry.name = String(name);
      return entry;
    });
  };

  let datasources = entries(config.datasource_luids, config.datasource_names);
  if (datasources.length === 0 && inp.datasource_luids) {
    datasources = entries(inp.datasource_luids, inp.datasource_names);
  }
  if (datasources.length === 0) {
    const single = real(config.datasource_luid) || real(inp.datasource_luid);
    if (single) {
      const entry: Record<string, unknown> = { datasourceLuid: single };
      const name = config.datasource_name || inp.datasource_name;
      if (name) entry.name = String(name);
      datasources = [entry];
    }
  }
  if (!workbookLuid || datasources.length === 0) {
    throw new Error(
      "CABU runs need the published workbook/datasource LUIDs: set " +
        "'workbook_luid' and 'datasource_luid' (or 'datasource_luids') in " +
        "the run config (the suite YAML carries PLACEHOLDER values by design)",
    );
  }
  return { workbookLuid, datasources };
}

/**
 * (workbookLuid, first datasourceLuid, its name): the single-source view of
 * `resolveTargets`, kept for callers that want one id. Mirrors `_resolve_luids`.
 */
export function resolveLuids(
  config: RunConfig,
  inp: Record<string, unknown>,
): { workbookLuid: string; datasourceLuid: string; datasourceName: string | null } {
  const { workbookLuid, datasources } = resolveTargets(config, inp);
  const first = datasources[0]!;
  return {
    workbookLuid,
    datasourceLuid: first.datasourceLuid as string,
    datasourceName: (first.name as string | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function expectedDict(inp: Record<string, unknown>): Record<string, unknown> {
  return {
    user_friendly_reply:
      (inp.ground_truth_answer as string) || (inp.expected_answer as string) || "",
    output_type: inp.output_type || "SQ",
  };
}

/** The outcome of running one CABU case (the adapter's own struct). */
export interface CabuOutcome {
  answer?: string | null;
  query_response_data?: unknown[];
  utterance_type?: string | null;
  semantic_query?: string | null;
  query_explanation?: string | null;
  reasoning?: string | null;
  total_tokens?: number | null;
  llm_calls?: number | null;
  confidence_score?: number | null;
  classification_duration_ms?: unknown;
  action_duration_ms?: unknown;
  chat_luid?: string | null;
  /** Seconds spent waiting for the server's data source indexing limit. */
  rate_limit_wait_s?: number;
  conversation_trace_id?: string | null;
  utterance_trace_id?: string | null;
  waii_request_trace_id?: string | null;
  latency?: number | null;
  error?: unknown;
  follow_up_answers?: string[];
  judge_entries?: MetricEntry[];
}

/** SSE failures are structured payloads, not JavaScript Error instances. */
export function describeCabuError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const data = error as Record<string, unknown>;
    const code = data.error_code ?? data.errorCode;
    const detail = data.error_details ?? data.errorMsg ?? data.message ?? data.error;
    const message = detail != null && detail !== error ? describeCabuError(detail) : "";
    if (message || code) return [code, message].filter(Boolean).join(": ");
  }
  return JSON.stringify(redactSecrets(error)) ?? "Unknown Dashboard Q&A error";
}

/** Convert case + outcome → row payload. Mirrors `_serialize_case`. */
export function serializeCase(
  cabuCase: CabuCase,
  datasourceLabel: string | null,
  outcome: CabuOutcome,
): RowPayload {
  const inp = cabuCase.input;
  const answer = outcome.answer || "";

  let actual: Record<string, unknown> = {};
  if (answer || outcome.semantic_query) {
    actual = {
      user_friendly_reply: answer,
      semantic_query: outcome.semantic_query ?? null,
      utterance_type: outcome.utterance_type ?? null,
    };
  }

  const metrics: Record<string, MetricEntry[]> = {};
  // The server's classification and the case's expected type use different
  // vocabularies. Keep them for display, never score their equality.
  if (outcome.judge_entries && outcome.judge_entries.length > 0) {
    metrics.llmJudge ??= [];
    metrics.llmJudge.push(...outcome.judge_entries);
  }

  const errors: RowError[] = [];
  if (outcome.error) {
    errors.push({
      phase: "cabu",
      description: describeCabuError(outcome.error).slice(0, 500),
      warning: false,
    });
  }
  if (outcome.rate_limit_wait_s) {
    errors.push({
      phase: "cabu",
      description:
        `Waited ${minutes(outcome.rate_limit_wait_s * 1000)} for the server's data source ` +
        "indexing limit (WAII) before this question could be asked.",
      warning: true,
    });
  }

  const debugInfo: Record<string, unknown> = {};
  if (outcome.error && typeof outcome.error === "object") {
    debugInfo.server_error = redactSecrets(outcome.error);
  }
  if (outcome.query_response_data)
    debugInfo.query_response_data = outcome.query_response_data.slice(0, 200);
  for (const key of ["reasoning", "semantic_query", "query_explanation"] as const) {
    const v = outcome[key];
    if (typeof v === "string" && v) debugInfo[key] = v.slice(0, DEBUG_TEXT_CAP);
  }
  for (const key of [
    "total_tokens",
    "llm_calls",
    "confidence_score",
    "classification_duration_ms",
    "action_duration_ms",
    "chat_luid",
    "conversation_trace_id",
    "utterance_trace_id",
    "waii_request_trace_id",
  ] as const) {
    const v = outcome[key];
    if (v != null) debugInfo[key] = v;
  }
  if (outcome.follow_up_answers && outcome.follow_up_answers.length > 0) {
    debugInfo.follow_up_answers = outcome.follow_up_answers;
  }

  return {
    test_case_id: cabuCase.caseId,
    runner: RUNNER_NAME,
    datasource: datasourceLabel,
    utterance: (inp.utterance as string) || "",
    turn: 0,
    expected: expectedDict(inp),
    actual,
    latency: outcome.latency ?? null,
    errors,
    metrics,
    debug_info: debugInfo,
    info: { tags: cabuCase.tags || [], ...(cabuCase.groundTruth ? { ground_truth: cabuCase.groundTruth } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Case execution
// ---------------------------------------------------------------------------

async function runCase(
  client: TabCabuServiceClient,
  config: RunConfig,
  cabuCase: CabuCase,
  clock: () => number,
): Promise<CabuOutcome> {
  const inp = cabuCase.input;
  const { workbookLuid, datasources } = resolveTargets(config, inp);
  const vizqlRoutingKey =
    (config.vizql_routing_key as string) || (inp.vizql_routing_key as string) || null;

  const runSignal = config._run_signal as AbortSignal | undefined;
  client.questionSignal = runSignal
    ? AbortSignal.any([runSignal, AbortSignal.timeout(600000)])
    : AbortSignal.timeout(600000);
  const outcome: CabuOutcome = {};

  const start = clock();
  await client.createConversation({
    workbookLuid,
    dashboardDatasources: datasources,
    sessionId: "",
    wgSessionId: client.authToken,
    vizqlRoutingKey,
  });
  await client.postUtterance({
    utterance: (inp.utterance as string) || "",
    sessionId: "",
    wgSessionId: client.authToken,
    vizqlRoutingKey,
  });
  const events = await client.streamConversation();
  outcome.latency = (clock() - start) / 1000.0;

  outcome.answer = client.getFinalAnswer(events);
  outcome.query_response_data = client.getFirstExecutionData(events) || [];
  outcome.utterance_type = client.getUtteranceType(events);
  outcome.semantic_query = client.getGeneratedSql(events);
  outcome.query_explanation = client.getDataDetails(events);
  outcome.reasoning = client.getReasoningText(events);
  outcome.total_tokens = client.getTotalLlmTokens(events);
  outcome.llm_calls = client.getLlmCallCount(events);
  outcome.confidence_score = client.getConfidenceScore(events);
  const durations = client.getPhaseDurations(events);
  outcome.classification_duration_ms = durations.classification_duration_ms;
  outcome.action_duration_ms = durations.action_duration_ms;
  outcome.chat_luid = client.getChatLuid(events) || "";
  outcome.conversation_trace_id = client.conversationTraceId;
  outcome.utterance_trace_id = client.utteranceTraceId;
  outcome.waii_request_trace_id = client.getWaiiRequestTraceId(events);

  const streamError = client.getError(events);
  if (streamError && !outcome.answer) {
    // The agent reported an error instead of an answer (its LLM gateway call
    // failed, a classification error): the question was not answered, so it
    // is retried and, if it keeps failing, recorded as a failed question that
    // Resume asks again.
    throw new ServerAnsweredWithError(streamError);
  }
  // A generated apology or partial answer must not hide a structured failure.
  if (streamError) {
    outcome.error = streamError;
  }

  // -- follow-ups (multi-turn) in the same conversation -------------------
  const followUps = (inp.follow_up_utterances as string[]) || [];
  if (followUps.length > 0) {
    const answers: string[] = [];
    let chatLuid = outcome.chat_luid || "";
    for (const followUp of followUps) {
      try {
        client.parentLuid = chatLuid;
        await client.postUtterance({
          utterance: followUp,
          sessionId: "",
          wgSessionId: client.authToken,
          vizqlRoutingKey,
        });
        const fuEvents = await client.streamConversation();
        answers.push(client.getFinalAnswer(fuEvents) || "");
        chatLuid = client.getChatLuid(fuEvents) || chatLuid;
      } catch (error) {
        if (isAuthError(error)) throw error;
      // Non-auth follow-up failures retain partial answers.
        break;
      }
    }
    outcome.follow_up_answers = answers;
  }

  return outcome;
}

function isAuthError(exc: unknown): boolean {
  return exc instanceof CabuHttpError && (exc.status === 401 || exc.status === 403);
}

/** The server's own `errorMsg` from a CES error body, or the body's start. */
function serverErrorMessage(body: string): string {
  try {
    const data = body ? (JSON.parse(body) as unknown) : {};
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const msg = (data as { errorMsg?: unknown }).errorMsg;
      if (msg) return String(msg).trim();
    }
  } catch {
    // not JSON: fall through to the body's start
  }
  return body.trim().slice(0, 200);
}

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

function isNetworkError(exc: unknown): boolean {
  const name = (exc as { name?: unknown } | null)?.name;
  const code = String((exc as { code?: unknown } | null)?.code ?? "");
  return name === "TimeoutError" || NETWORK_ERROR_CODES.has(code);
}

/**
 * What the results page shows for a case the server did not answer: what went
 * wrong and what to do, in the admin's terms. The log keeps the raw exception.
 * Python's httpx TimeoutException /
 * ConnectError / NetworkError are a fetch TimeoutError or a network error
 * code here.
 */
export function explainFailure(exc: unknown): string {
  if (exc instanceof ServerAnsweredWithError) {
    const code = exc.code ? `; code ${exc.code}` : "";
    return (
      "Tableau Server's Dashboard Q&A agent answered with an error instead of an answer " +
      `(server error event${code}): ${exc.details.slice(0, 300)}. The question was asked again ` +
      "after a wait and failed each time. If this keeps happening, the LLM gateway the " +
      "site is connected to, or the Dashboard Q&A service, needs attention on the " +
      "server; ask your Tableau administrator. Resume the evaluation to ask it again."
    );
  }
  if ((exc as { name?: string })?.name === "TimeoutError") {
    return "Tableau Server did not answer the question within 10 minutes, so the tool stopped waiting. The server hung on this question; it was not asked again. Try it by hand in Tableau Agent in Dashboards; if it hangs there too, ask your Tableau administrator.";
  }
  if (exc instanceof CabuHttpError) {
    const status = exc.status;
    const detail = serverErrorMessage(exc.body ?? "");
    const said = detail ? ` The server said: ${detail}` : "";
    if (isRateLimited(exc)) {
      const waited = Number((exc as { rateLimitWaitedMs?: number }).rateLimitWaitedMs ?? 0);
      const short = detail ? ` The server said: ${detail.slice(0, 140)}` : "";
      return (
        "The server limits how often a data source can be indexed for Dashboard Q&A, " +
        `and the limit was still in force after the tool waited ${minutes(waited)} ` +
        `(HTTP ${status}).${short} The tool waits for this limit on its own, up to an hour ` +
        "per question; resume the evaluation later, or ask your Tableau administrator to " +
        "raise the WAII indexing limit for the evaluation site."
      );
    }
    if (status >= 500 && detail.toLowerCase().includes("waii")) {
      return (
        "The server's Dashboard Q&A service is not available, so no question can be " +
        `answered (HTTP ${status}).${said} Tableau Agent in Dashboards is turned on for ` +
        "the site, but the service behind it is not running or not reachable from the " +
        "server. Ask your Tableau administrator to check the Dashboard Q&A service; " +
        "the tool cannot fix this."
      );
    }
    if (status === 401) {
      return (
        "Tableau Server did not accept the session for the Dashboard Q&A request " +
        `(HTTP 401).${said} Test the connection in Evaluation Setup, step 1, then ` +
        "evaluate again."
      );
    }
    if (status === 403) {
      return (
        `Tableau Server refused the Dashboard Q&A request (HTTP 403).${said} Check that ` +
        "Tableau Agent in Dashboards is turned on for the site and that the token's " +
        "user can open the sample workbook; then evaluate again."
      );
    }
    if (status === 404) {
      const phase = exc.phase === "createConversation"
        ? "creating a conversation"
        : exc.phase === "postUtterance"
          ? "submitting the question"
          : exc.phase === "streamConversation"
            ? "streaming the answer"
            : exc.phase;
      return (
        `Tableau Server returned HTTP 404 while ${phase}.${said} ` +
        "This can mean a missing resource or request context, not necessarily a missing " +
        "Dashboard Q&A endpoint. Check the published workbook/data source ids and the " +
        "server's response."
      );
    }
    if (status >= 500) {
      return (
        `The server's Dashboard Q&A endpoint failed (HTTP ${status}).${said} Try again ` +
        "later; if it keeps failing, ask your Tableau administrator."
      );
    }
    return `Tableau Server rejected the Dashboard Q&A request (HTTP ${status}).${said}`;
  }
  const msg = exc instanceof Error ? exc.message : String(exc);
  if (isNetworkError(exc)) {
    return (
      `Tableau Server could not be reached for the Dashboard Q&A request (${msg}). ` +
      "Check the VPN and the network, test the connection in Evaluation Setup, step 1, " +
      "then evaluate again."
    );
  }
  const name = exc instanceof Error ? exc.constructor.name : "Error";
  return `${name}: ${msg}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Injectable loader for suite YAML. */
export type CabuSuiteLoader = (config: RunConfig) => Promise<CabuCase[]> | CabuCase[];

/** Injectable factory for the shared client (lets tests supply a fake fetch). */
export type CabuClientFactory = (
  config: RunConfig,
) => Promise<TabCabuServiceClient> | TabCabuServiceClient;

export interface CabuAdapterOptions {
  loadSuite: CabuSuiteLoader;
  clientFactory: CabuClientFactory;
  judgeCaller?: JudgeCaller;
  /** Judge config resolver. */
  resolveJudgeConfig?: (config: RunConfig) => CabuJudgeConfig | null;
  /** Injectable clock (ms) for deterministic latency in tests. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CabuOpaque {
  cases: CabuCase[];
}

export class CabuAdapter implements EvalAdapter {
  readonly id = "cabu";
  private readonly _loadSuite: CabuSuiteLoader;
  private readonly _clientFactory: CabuClientFactory;
  private readonly _judgeCaller?: JudgeCaller;
  private readonly _resolveJudgeConfig?: (config: RunConfig) => CabuJudgeConfig | null;
  private readonly _clock: () => number;
  private readonly _sleep: (ms: number) => Promise<void>;

  constructor(opts: CabuAdapterOptions) {
    this._loadSuite = opts.loadSuite;
    this._clientFactory = opts.clientFactory;
    this._judgeCaller = opts.judgeCaller;
    this._resolveJudgeConfig = opts.resolveJudgeConfig;
    this._clock = opts.clock ?? (() => Date.now());
    this._sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  session(_config: RunConfig, _jobId: string): AdapterSession {
    // No global state to install (self-contained client). Validation happens at
    // load() when LUIDs are resolved for the first case.
    return { close() {} };
  }

  async load(config: RunConfig): Promise<SuitePlan> {
    const cases = await this._loadSuite(config);
    if (cases.length === 0) {
      throw new Error("No runnable CABU cases found");
    }
    // LUIDs must resolve for at least the first case up front.
    if (!config._content_from_tool) resolveTargets(config, cases[0]!.input);

    const dsLabel =
      (config.datasource_name as string) || (config.datasource_luid as string) || null;
    const skeletons: CaseSkeleton[] = [];
    const conversation_ids: string[][] = [];
    for (const c of cases) {
      const partIds = (config._part_ids || {}) as Record<string, Record<string, unknown>>;
      const ownIds = partIds[String(c.input._part || "")] || {};
      const rowLabel = String(ownIds.datasource_label || ownIds.datasource_name || c.input._part_label || dsLabel || "") || null;
      conversation_ids.push([c.caseId]);
      skeletons.push({
        test_case_id: c.caseId,
        runner: RUNNER_NAME,
        datasource: rowLabel,
        utterance: (c.input.utterance as string) || "",
        expected: expectedDict(c.input),
      });
    }
    const opaque: CabuOpaque = { cases };
    return { total: cases.length, skeletons, conversation_ids, opaque };
  }

  async execute(
    plan: SuitePlan,
    config: RunConfig,
    emitCase: EmitCase,
    shouldStop: ShouldStop,
    completedIds: Set<string>,
  ): Promise<void> {
    const opaque = plan.opaque as CabuOpaque;
    const shared = await this._clientFactory(config);

    const judgeCfg =
      config.compute_nl_judge && this._resolveJudgeConfig ? this._resolveJudgeConfig(config) : null;

    const dsLabel =
      (config.datasource_name as string) || (config.datasource_luid as string) || null;
    let consecutiveAuthFailures = 0;
    let consecutiveServiceFailures = 0;
    let fatal: unknown;
    let halted = false;
    const stopped: ShouldStop = () => halted ? "failure" : shouldStop();

    const executeCase = async (cabuCase: CabuCase): Promise<void> => {
      if (stopped()) {
        return;
      }
      if (completedIds.has(cabuCase.caseId)) {
        return;
      }
      plan.case_started?.(cabuCase.caseId);
      const partIds = (config._part_ids || {}) as Record<string, Record<string, unknown>>;
      const ownIds = partIds[String(cabuCase.input._part || "")] || {};
      const rowLabel =
        String(
          ownIds.datasource_label ||
            ownIds.datasource_name ||
            cabuCase.input._part_label ||
            dsLabel ||
            "",
        ) || null;

      let outcome: CabuOutcome;
      try {
        outcome = await this.runWithRetries(shared, config, cabuCase, stopped);
        consecutiveAuthFailures = 0;
        consecutiveServiceFailures = 0;
      } catch (exc) {
        if (isAuthError(exc)) {
          consecutiveAuthFailures += 1;
          if (consecutiveAuthFailures >= AUTH_FAILURE_LIMIT) {
            halted = true;
            fatal ??= new Error(
              `${consecutiveAuthFailures} consecutive auth failures against the ` +
                "CABU endpoint — check the PAT/credentials and that the server " +
                "enables Dashboard Q&A (AnalyticsAssistantCabuWaii)",
            );
            await emitCase(serializeCase(cabuCase, rowLabel, { error: explainFailure(exc) }));
            throw fatal;
          }
        } else {
          consecutiveAuthFailures = 0;
        }
        outcome = { error: explainFailure(exc) };
        if (
          (exc instanceof CabuHttpError && exc.status >= 500) ||
          isNetworkError(exc) ||
          exc instanceof ServerAnsweredWithError
        ) {
          consecutiveServiceFailures += 1;
          if (consecutiveServiceFailures >= SERVICE_FAILURE_LIMIT) {
            halted = true;
            fatal ??= new Error(
              `${consecutiveServiceFailures} questions in a row failed the ` +
                `same way, so the rest were not asked. ${outcome.error}`,
              { cause: exc },
            );
            await emitCase(serializeCase(cabuCase, rowLabel, outcome));
            throw fatal;
          }
        } else {
          consecutiveServiceFailures = 0;
        }
      }

      if (judgeCfg && this._judgeCaller && (outcome.answer || outcome.semantic_query)) {
        const inp = cabuCase.input;
        outcome.judge_entries = await computeCabuJudgeMetrics({
          question: (inp.utterance as string) || "",
          observedAnswer: answerForJudging(outcome.answer || "", outcome.query_response_data) || "",
          expectedAnswer:
            (inp.ground_truth_answer as string) || (inp.expected_answer as string) || "",
          queryResponseData: outcome.query_response_data,
          judgeCfg,
          callJudge: this._judgeCaller,
          // The Concierge judges read the prose expectation and the case's
          // kind, as required by the rubric.
          expectedProse: (inp.expected_answer as string) || "",
          outputType: (inp.output_type as string) || "SQ",
          answerSource: (inp.answer_source as string) || "ANSWER_SOURCE_SEMANTIC_QUERY",
          rowsKnown: rowsKnown(outcome),
        });
      }

      await emitCase(serializeCase(cabuCase, rowLabel, outcome));
    };
    // Completion-order failure streaks stop new work; already-started cases
    // are drained and persisted before propagating the first fatal error.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(resolveMaxConcurrency(config), opaque.cases.length) }, async () => {
      while (next < opaque.cases.length && !stopped()) {
        const cabuCase = opaque.cases[next++]!;
        try {
          await executeCase(cabuCase);
        } catch (error) {
          if (!halted) fatal = error;
          halted = true;
        }
      }
    }));
    if (halted) throw fatal;
  }

  /** Retry wire/server failures with a pause-aware wait, not a hung question. */
  private async runWithRetries(
    client: TabCabuServiceClient,
    config: RunConfig,
    testCase: CabuCase,
    shouldStop: ShouldStop,
  ): Promise<CabuOutcome> {
    const delays = [10000, 30000, 60000];
    let limitWaits = 0; // waits spent on the indexing limit (not attempts)
    let limitWaitedMs = 0;
    const session = sharedSession(String(config.job_id || ""));
    let recoveredAuth = false;
    let attempt = 0;
    for (;;) {
      const started = this._clock();
      const child = client.childClient();
      const lease = session ? await session.acquireConversationToken() : null;
      if (lease) child.authToken = lease.token;
      let failure: unknown;
      try {
        const outcome = await runCase(child, config, testCase, this._clock);
        if (limitWaitedMs > 0) outcome.rate_limit_wait_s = limitWaitedMs / 1000;
        return outcome;
      } catch (error) {
        failure = error;
      } finally {
        lease?.release();
      }
      const error = failure;
      if (isRateLimited(error) && !shouldStop()) {
        const delay = RATE_LIMIT_WAITS_MS[Math.min(limitWaits, RATE_LIMIT_WAITS_MS.length - 1)]!;
        if (limitWaitedMs + delay > RATE_LIMIT_MAX_WAIT_MS) {
          (error as { rateLimitWaitedMs?: number }).rateLimitWaitedMs = limitWaitedMs;
          throw error;
        }
        limitWaits += 1;
        limitWaitedMs += delay;
        if (await this.wait(delay, shouldStop)) throw error;
        continue;
      }
      if (error instanceof CabuHttpError && error.status === 401 && session && !recoveredAuth && !shouldStop()) {
        recoveredAuth = true;
        await session.handle401(child.authToken);
        continue;
      }
      // A timed-out question may still be running server-side; do not repeat it.
      if ((error as { name?: string })?.name === "TimeoutError") throw error;
      const retryable = error instanceof CabuHttpError
        ? error.status >= 500 || error.status === 429 : isNetworkError(error) || error instanceof ServerAnsweredWithError;
      if (!retryable || this._clock() - started >= 120000 || attempt >= delays.length || shouldStop()) throw error;
      if (await this.wait(delays[attempt++]!, shouldStop)) throw error;
    }
  }

  /** Sleep in short steps (tests inject the wait); true when a pause or cancel ended it. */
  private async wait(delayMs: number, shouldStop: ShouldStop): Promise<boolean> {
    let remaining = delayMs;
    while (remaining > 0 && !shouldStop()) {
      const step = Math.min(remaining, 5000);
      await this._sleep(step);
      remaining -= step;
    }
    return Boolean(shouldStop());
  }
}

export function createCabuAdapter(opts: CabuAdapterOptions): CabuAdapter {
  return new CabuAdapter(opts);
}

/**
 * Self-registration with the REAL loader + client factory. Both are the native
 * TypeScript implementations in `src/harness/cabu_runner.ts`:
 *   - {@link createCabuSuiteLoader} resolves the suite YAML from config
 *     (`test_path` / `cabu_suites_root` / `$TABLEAU_AI_EVAL_CABU_SUITES`) and parses it
 *     (js-yaml, the `yaml.safe_load` analogue) into {@link CabuCase}s;
 *   - {@link createCabuClientFactory} builds a per-run {@link TabCabuServiceClient}
 *     with a {@link TableauSession}-minted PAT token (or username/password
 *     signin) from config — NO import-time credential coupling.
 * Tests still inject their own loader/factory via {@link createCabuAdapter}.
 */
register(
  new CabuAdapter({
    loadSuite: createCabuSuiteLoader(),
    clientFactory: createCabuClientFactory(),
    resolveJudgeConfig: (config) => (config._judge_config as CabuJudgeConfig | undefined) ?? null,
    judgeCaller: (args) => callJudge({ ...args, fetchFn: fetch, retry: DEFAULT_RETRY_POLICY }),
  }),
);
