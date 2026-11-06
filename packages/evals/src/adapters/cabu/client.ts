/**
 * TabCabu (Dashboard Q&A / CABU) service client.
 * Supports dashboard conversations, streamed answers, and query results.
 *
 * ## Supported operations
 *
 * This client prioritizes the
 * parts the adapter/judge wiring actually needs, all as PURE functions with an
 * injectable `fetch` and no live calls:
 *
 * Implemented:
 *   - request builders: `buildLoginXml`, `buildCreateConversationBody`,
 *     `buildPostUtteranceBody`, and the per-phase header builders;
 *   - response parsers: `parseLoginXml`, `parseSseStream` (SSE framing),
 *     `parseCreateConversationResponse`, `parsePostUtteranceResponse`;
 *   - the full extraction-helper surface over the streamed events
 *     (`getFinalAnswer`, `getError`, `getUtteranceType`, `getGeneratedSql`,
 *     `getReasoningText`, `getFirstExecutionData`, `getTotalLlmTokens`,
 *     `getLlmCallCount`, `getConfidenceScore`, `getPhaseDurations`,
 *     `getChatLuid`, `getWaiiRequestTraceId`, and the token-usage traversal);
 *   - the `TabCabuServiceClient` class driving the three-phase flow
 *     (create_conversation → post_utterance → stream_conversation) over an
 *     injectable fetch, plus `child_client()` auth-state injection.
 *
 * Not needed by the adapter/judge:
 *   - `get_llm_usage_per_step` per-step breakdown, `get_waii_total_tokens`,
 *     `get_assumptions`, `get_mcp_query_count`, `count_responses` /
 *     `count_reasoning_responses`, `format_events_for_print`, and the various
 *     `get_*_trace_id` accessors beyond the WAII request trace id. These are
 *     observability/telemetry accessors the eval row payload does not consume;
 *     they can be added if needed.
 *
 * ## Login XML parsing
 *
 * `parseLoginXml` uses a small namespace-tolerant regex extractor:
 * find `credentials`, read `token`; find
 * `site`, read `id`; find `user`, read `id`) and throws the same
 * descriptive errors when a field is missing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { tlsInit } from "@tableau-ai-eval/core";

/** One SSE frame: (eventName, dataDict). Mirrors the Python tuple. */
export type SseEvent = [string, Record<string, unknown>];

/**
 * A minimal fetch signature — just the call form. Deliberately NOT `typeof
 * fetch`, which also requires the Bun-specific `preconnect` method; tests
 * inject a plain function, and the real global `fetch` is assignable here.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const XSRF_COOKIE_NAME = "XSRF-TOKEN";
const XSRF_TOKEN_VALUE = "tableau-ai-eval";
const WORKGROUP_SESSION_COOKIE_NAME = "workgroup_session_id";

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

/**
 * Coerce a JSON int or digit-string to a number; null for anything else.
 * Booleans are rejected. Mirrors `_coerce_int`.
 */
export function coerceInt(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode HTML entities (mirrors Python `html.unescape`, common entities). */
export function htmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Login XML: build + parse
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the Tableau REST signin body. Mirrors the ET.tostring in `_do_login`. */
export function buildLoginXml(username: string, password: string, sitename: string): string {
  return (
    `<tsRequest>` +
    `<credentials name="${xmlEscape(username)}" password="${xmlEscape(password)}">` +
    `<site contentUrl="${xmlEscape(sitename)}" />` +
    `</credentials>` +
    `</tsRequest>`
  );
}

/** Read an attribute off the first matching (namespace-tolerant) tag. */
function xmlAttr(xml: string, tag: string, attr: string): string | null {
  // Match <ns:tag ...> or <tag ...>, capture the attribute run.
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*)>`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  const attrRe = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i");
  const am = attrRe.exec(m[1]!);
  return am ? am[1]! : null;
}

/**
 * Parse a Tableau Cloud login XML response → { token, siteId, userId }.
 * Mirrors `_parse_login_xml`, including the raised errors.
 */
export function parseLoginXml(xml: string): {
  token: string;
  siteId: string;
  userId: string;
} {
  if (!/<(?:[\w.-]+:)?credentials\b/i.test(xml)) {
    throw new Error("Could not find credentials element in XML response");
  }
  const token = xmlAttr(xml, "credentials", "token");
  if (!token) {
    throw new Error("Token not found in credentials element");
  }
  if (!/<(?:[\w.-]+:)?site\b/i.test(xml)) {
    throw new Error("Could not find site element in XML response");
  }
  const siteId = xmlAttr(xml, "site", "id");
  if (!siteId) {
    throw new Error("Site id not found in site element");
  }
  if (!/<(?:[\w.-]+:)?user\b/i.test(xml)) {
    throw new Error("Could not find user element in XML response");
  }
  const userId = xmlAttr(xml, "user", "id");
  if (!userId) {
    throw new Error("User id not found in user element");
  }
  return { token, siteId, userId };
}

// ---------------------------------------------------------------------------
// Request body builders (Phase 1 / Phase 2)
// ---------------------------------------------------------------------------

export interface CreateConversationArgs {
  workbookLuid: string | null;
  dashboardDatasources: Record<string, unknown>[];
  traceId: string;
  sessionId?: string | null;
  wgSessionId?: string | null;
  vizqlRoutingKey?: string | null;
}

/** Build the Phase-1 create_conversation body. Mirrors `create_conversation`. */
export function buildCreateConversationBody(a: CreateConversationArgs): Record<string, unknown> {
  if (a.workbookLuid !== null && a.workbookLuid === "") {
    throw new Error("workbook_luid cannot be empty string; pass null to omit");
  }
  if (!a.dashboardDatasources || a.dashboardDatasources.length === 0) {
    throw new Error("dashboard_datasources cannot be empty");
  }
  const body: Record<string, unknown> = {
    dashboardDatasources: a.dashboardDatasources,
    sessionId: a.sessionId != null ? a.sessionId : "",
    traceId: a.traceId,
  };
  if (a.workbookLuid !== null) body.workbookLuid = a.workbookLuid;
  if (a.wgSessionId != null) body.wgSessionId = a.wgSessionId;
  if (a.vizqlRoutingKey != null) body.vizqlRoutingKey = a.vizqlRoutingKey;
  return body;
}

export interface PostUtteranceArgs {
  utterance: string;
  scope: string;
  sdmNames: string[];
  parentLuid: string;
  traceId: string;
  locale?: string;
  language?: string;
  source?: string;
  sessionId?: string | null;
  wgSessionId?: string | null;
  vizqlRoutingKey?: string | null;
}

/** Build the Phase-2 post_utterance body. Mirrors `post_utterance`. */
export function buildPostUtteranceBody(a: PostUtteranceArgs): Record<string, unknown> {
  if (!a.utterance) {
    throw new Error("utterance cannot be empty");
  }
  const datasources = a.sdmNames.map((sdm) => ({
    sdmName: sdm,
    datasourceLuid: sdm,
  }));
  const body: Record<string, unknown> = {
    utterance: { content: a.utterance, source: a.source ?? "user" },
    localization: { locale: a.locale ?? "en_US", language: a.language ?? "en" },
    scope: a.scope,
    datasources,
    parentLuid: a.parentLuid,
    sessionId: a.sessionId != null ? a.sessionId : "",
    traceId: a.traceId,
  };
  if (a.wgSessionId != null) body.wgSessionId = a.wgSessionId;
  if (a.vizqlRoutingKey != null) body.vizqlRoutingKey = a.vizqlRoutingKey;
  return body;
}

// ---------------------------------------------------------------------------
// Response parsers (Phase 1 / Phase 2)
// ---------------------------------------------------------------------------

/**
 * Parse Phase-1 create_conversation response → { conversationId, scope,
 * sdmNames }. Mirrors the old/new response-format handling.
 */
export function parseCreateConversationResponse(data: unknown): {
  conversationId: string;
  scope: string;
  sdmNames: string[];
} {
  if (!isObj(data)) throw new Error("No conversationId found in response");
  const conversationId = data.conversationId;
  if (!conversationId || typeof conversationId !== "string") {
    throw new Error("No conversationId found in response");
  }
  const scope = data.scope;
  if (!scope || typeof scope !== "string") {
    throw new Error("No scope found in response");
  }
  let sdmNames = data.sdmNames as unknown;
  if (!sdmNames || (Array.isArray(sdmNames) && sdmNames.length === 0)) {
    const datasources = (data.datasources as unknown[]) || [];
    const collected: string[] = [];
    for (const ds of datasources) {
      if (isObj(ds) && typeof ds.sdmName === "string" && ds.sdmName) {
        collected.push(ds.sdmName);
      }
    }
    if (collected.length === 0) {
      throw new Error("No sdmNames found in response");
    }
    sdmNames = collected;
  }
  return {
    conversationId,
    scope,
    sdmNames: (sdmNames as unknown[]).map((s) => String(s)),
  };
}

/**
 * Parse Phase-2 post_utterance response → { utteranceId, b3TraceId }. Mirrors
 * `post_utterance`, including dropping a non-string b3TraceId.
 */
export function parsePostUtteranceResponse(data: unknown): {
  utteranceId: string;
  b3TraceId: string | null;
} {
  if (!isObj(data)) throw new Error("No utteranceId found in response");
  const utteranceId = data.utteranceId;
  if (!utteranceId || typeof utteranceId !== "string") {
    throw new Error("No utteranceId found in response");
  }
  const b3 = data.b3TraceId;
  return {
    utteranceId,
    b3TraceId: typeof b3 === "string" && b3 ? b3 : null,
  };
}

// ---------------------------------------------------------------------------
// SSE stream parsing
// ---------------------------------------------------------------------------

function parseSseEventData(dataLines: string[]): Record<string, unknown> {
  const joined = dataLines.join("\n");
  if (!joined) return {};
  try {
    const parsed = JSON.parse(joined);
    return isObj(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

/**
 * Parse a full SSE text body into `(event_name, data)` frames, in arrival
 * order. Stops after the `complete` event. Mirrors `_iter_sse_events`,
 * including the final flush of a trailing unterminated frame.
 *
 * Pure over the raw text so it is trivially testable with an injected fetch
 * that returns a fixed SSE string.
 */
export function parseSseStream(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  let currentEventName: string | null = null;
  let currentEventData: string[] = [];

  const lines = body.split(/\r?\n/);
  let completed = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentEventData.length > 0 || currentEventName) {
        const eventName = currentEventName || "";
        const data = parseSseEventData(currentEventData);
        events.push([eventName, data]);
        if (eventName === "complete") {
          completed = true;
          break;
        }
      }
      currentEventName = null;
      currentEventData = [];
    } else if (line.startsWith("data:")) {
      const content = line.slice(5).trim();
      if (content) currentEventData.push(content);
    } else if (line.startsWith("event:")) {
      currentEventName = line.slice(6).trim();
    }
    // `id:` lines are ignored (debug-only).
  }

  // Final flush of a trailing frame with no blank-line terminator.
  if (!completed && (currentEventData.length > 0 || currentEventName)) {
    const eventName = currentEventName || "";
    events.push([eventName, parseSseEventData(currentEventData)]);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Extraction helpers (pure, operate on an SseEvent[] array)
// ---------------------------------------------------------------------------

/** First `response_complete` event's data, or null. */
function firstResponseComplete(events: SseEvent[]): Record<string, unknown> | null {
  for (const [name, data] of events) {
    if (name === "response_complete") return data;
  }
  return null;
}

/** First task_history[0] entry from response_complete.debug_context. */
function firstTaskHistoryEntry(events: SseEvent[]): Record<string, unknown> | null {
  for (const [name, data] of events) {
    if (name !== "response_complete") continue;
    const dbg = (data.debug_context as Record<string, unknown>) || {};
    const resp = (dbg.response as Record<string, unknown>) || {};
    const taskHistory = resp.task_history;
    if (Array.isArray(taskHistory) && taskHistory.length > 0) {
      const first = taskHistory[0];
      return isObj(first) ? first : null;
    }
  }
  return null;
}

/** The iter_0_query dict from the first task_history response. */
function firstIterQuery(events: SseEvent[]): Record<string, unknown> | null {
  const entry = firstTaskHistoryEntry(events);
  if (entry === null) return null;
  const resp = (entry.response as Record<string, unknown>) || {};
  const respData = (resp.response_data as Record<string, unknown>) || {};
  const queryMap = (respData.query as Record<string, unknown>) || {};
  const q = queryMap.iter_0_query;
  return isObj(q) ? q : null;
}

/** `response` from the first response_complete, HTML-unescaped. */
export function getFinalAnswer(events: SseEvent[]): string | null {
  const data = firstResponseComplete(events);
  if (!data) return null;
  const answer = data.response;
  return typeof answer === "string" ? htmlUnescape(answer) : null;
}

/** First error payload (event:error or response_complete with error_*), or null. */
export function getError(events: SseEvent[]): Record<string, unknown> | null {
  for (const [name, data] of events) {
    if (name === "error") return data;
    if (
      name === "response_complete" &&
      (data.error_code != null || data.error_details != null)
    ) {
      return data;
    }
  }
  return null;
}

/** `utteranceType` from classification_complete. */
export function getUtteranceType(events: SseEvent[]): string | null {
  for (const [name, data] of events) {
    if (name === "classification_complete") {
      const ut = data.utteranceType;
      return typeof ut === "string" ? ut : null;
    }
  }
  return null;
}

/** Generated SQL from iter_0_query.query. */
export function getGeneratedSql(events: SseEvent[]): string | null {
  const iq = firstIterQuery(events);
  if (!iq) return null;
  const q = iq.query;
  return typeof q === "string" ? q : null;
}

/** dataDetails from response_complete. */
export function getDataDetails(events: SseEvent[]): string | null {
  const data = firstResponseComplete(events);
  if (!data) return null;
  const dd = data.dataDetails;
  return typeof dd === "string" ? dd : null;
}

/** Concatenated reasoning titles/text from reasoning_complete events. */
export function getReasoningText(events: SseEvent[]): string {
  const parts: string[] = [];
  for (const [name, data] of events) {
    if (name !== "reasoning_complete") continue;
    const title = typeof data.title === "string" ? data.title : "";
    const reasoning = typeof data.reasoning === "string" ? data.reasoning : "";
    if (title && reasoning) parts.push(`[${title}] ${reasoning}`);
    else if (title) parts.push(`[${title}]`);
    else if (reasoning) parts.push(reasoning);
  }
  return parts.join("\n");
}

/** chatLuid from response_complete (multi-turn continuation). */
export function getChatLuid(events: SseEvent[]): string | null {
  const data = firstResponseComplete(events);
  if (!data) return null;
  const cl = data.chatLuid;
  return typeof cl === "string" ? cl : null;
}

/** Query result rows from response_complete.datatables[*].data, with fallback. */
export function getFirstExecutionData(events: SseEvent[]): Record<string, unknown>[] | null {
  for (const [name, data] of events) {
    if (name !== "response_complete") continue;
    const datatables = data.datatables;
    if (Array.isArray(datatables)) {
      for (const dt of datatables) {
        if (isObj(dt) && Array.isArray(dt.data)) {
          return dt.data as Record<string, unknown>[];
        }
      }
    }
  }
  const entry = firstTaskHistoryEntry(events);
  if (entry === null) return null;
  const resp = (entry.response as Record<string, unknown>) || {};
  const respData = (resp.response_data as Record<string, unknown>) || {};
  const dataMap = (respData.data as Record<string, unknown>) || {};
  const iterData = dataMap.iter_0_data;
  if (isObj(iterData) && Array.isArray(iterData.rows)) {
    return (iterData.rows as unknown[]).map((r) =>
      isObj(r) && "val" in r ? (r.val as Record<string, unknown>) : (r as Record<string, unknown>),
    );
  }
  return null;
}

/** WAII self-assessed confidence value, or null. */
export function getConfidenceScore(events: SseEvent[]): number | null {
  const iq = firstIterQuery(events);
  if (!iq) return null;
  const cs = iq.confidenceScore;
  if (isObj(cs)) {
    const val = cs.confidenceValue;
    return val != null ? Number(val) : null;
  }
  return null;
}

/** classification/action durations from debug_context. */
export function getPhaseDurations(events: SseEvent[]): {
  classification_duration_ms: unknown;
  action_duration_ms: unknown;
} {
  const data = firstResponseComplete(events);
  if (data) {
    const dbg = (data.debug_context as Record<string, unknown>) || {};
    const classification = (dbg.classification as Record<string, unknown>) || {};
    const action = (dbg.action as Record<string, unknown>) || {};
    return {
      classification_duration_ms: classification.duration_ms ?? null,
      action_duration_ms: action.duration_ms ?? null,
    };
  }
  return { classification_duration_ms: null, action_duration_ms: null };
}

/** All iter_*_query dicts from debug_context.response.task_history. */
function iterQueryEntries(debugContext: Record<string, unknown>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const responseSection = (debugContext.response as Record<string, unknown>) || {};
  const taskHistory = (responseSection.task_history as unknown[]) || [];
  for (const historyEntry of taskHistory) {
    if (!isObj(historyEntry)) continue;
    const resp = (historyEntry.response as Record<string, unknown>) || {};
    const respData = (resp.response_data as Record<string, unknown>) || {};
    const queryMap = (respData.query as Record<string, unknown>) || {};
    for (const iterQuery of Object.values(queryMap)) {
      if (isObj(iterQuery)) entries.push(iterQuery);
    }
  }
  return entries;
}

/** WAII tokenTotal for one iter_query, or null. Mirrors `_waii_token_total`. */
function waiiTokenTotal(iterQuery: Record<string, unknown>): number | null {
  const llmResponseWithReasoning =
    (iterQuery.llmResponseWithReasoning as Record<string, unknown>) || {};
  const llmResponse = (llmResponseWithReasoning.llmResponse as Record<string, unknown>) || {};
  const usageStats = (llmResponse.llmUsageStats as Record<string, unknown>) || {};
  const raw = usageStats.tokenTotal;
  if (raw == null) return null;
  return coerceInt(raw);
}

/**
 * (section, callId, callData, genParams, usage) for each CABU call with a
 * usage block. Mirrors `_source_a_usages`.
 */
function sourceAUsages(
  debugContext: Record<string, unknown>,
): [string, string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>][] {
  const results: [
    string,
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ][] = [];
  for (const [sectionName, sectionData] of Object.entries(debugContext)) {
    if (!isObj(sectionData)) continue;
    for (const [callId, callData] of Object.entries(sectionData)) {
      if (!isObj(callData)) continue;
      const llmResponse = (callData.llm_response as Record<string, unknown>) || {};
      const genDetails = (llmResponse.generation_details as Record<string, unknown>) || {};
      const genParams = (genDetails.parameters as Record<string, unknown>) || {};
      const usage = (genParams.usage as Record<string, unknown>) || {};
      if (Object.keys(usage).length === 0) continue;
      results.push([sectionName, callId, callData, genParams, usage]);
    }
  }
  return results;
}

/** Sum LLM token totals across all usage blocks. Mirrors `get_total_llm_tokens`. */
export function getTotalLlmTokens(events: SseEvent[]): number {
  let total = 0;
  for (const [name, data] of events) {
    if (name !== "response_complete") continue;
    const debugContext = (data.debug_context as Record<string, unknown>) || {};
    for (const [, , , , usage] of sourceAUsages(debugContext)) {
      const cabuTokens = coerceInt(usage.total_tokens);
      if (cabuTokens !== null) total += cabuTokens;
    }
    for (const iterQuery of iterQueryEntries(debugContext)) {
      const waiiTokens = waiiTokenTotal(iterQuery);
      if (waiiTokens !== null) total += waiiTokens;
    }
  }
  return total;
}

/** Count distinct LLM call entries in debug_context. Mirrors `get_llm_call_count`. */
export function getLlmCallCount(events: SseEvent[]): number {
  let count = 0;
  for (const [name, data] of events) {
    if (name !== "response_complete") continue;
    const debugContext = (data.debug_context as Record<string, unknown>) || {};
    for (const sectionData of Object.values(debugContext)) {
      if (!isObj(sectionData)) continue;
      for (const callData of Object.values(sectionData)) {
        if (!isObj(callData)) continue;
        if ("llm_response" in callData || "llm_duration_ms" in callData) {
          count += 1;
        }
      }
    }
  }
  return count;
}

/** WAII-internal request trace id from task_history[0].request.trace_id. */
export function getWaiiRequestTraceId(events: SseEvent[]): string | null {
  const entry = firstTaskHistoryEntry(events);
  if (entry === null) return null;
  const req = (entry.request as Record<string, unknown>) || {};
  const tid = req.trace_id;
  return tid ? String(tid) : null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** HTTP error carrying a status, so the adapter can detect 401/403. */
export class CabuHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly phase: string;
  constructor(status: number, body: string, phase: string) {
    super(`HTTP ${status} during ${phase}`);
    this.name = "CabuHttpError";
    this.status = status;
    this.body = body;
    this.phase = phase;
  }
}

export interface TabCabuClientOptions {
  baseUrl: string;
  loginBaseUrl?: string;
  username?: string | null;
  password?: string | null;
  sitename?: string | null;
  parentLuid?: string;
  /** Passed to the fetch TLS option: false disables verification. */
  sslVerify?: boolean;
  /** PEM CA bundle path to trust when sslVerify is true (private/enterprise CA). */
  caBundlePath?: string;
  /** Injectable fetch (defaults to global). No live calls without this in tests. */
  fetchImpl?: FetchLike;
  /** Injectable UUID/hex generator for deterministic trace ids in tests. */
  uuidHex?: () => string;
}

/**
 * Client for the WAII-backed CABU REST surface. Drives the three-phase flow
 * over an injectable fetch. State (conversation/utterance ids, trace ids,
 * streamed events) is held on the instance.
 */
export class TabCabuServiceClient {
  private readonly _baseUrl: string;
  private readonly _loginBaseUrl: string;
  private readonly _sslVerify: boolean;
  private readonly _caBundlePath?: string;
  private readonly _fetch: FetchLike;
  private readonly _uuidHex: () => string;

  username: string | null;
  password: string | null;
  sitename: string | null;
  parentLuid: string;

  authToken: string | null = null;
  siteLuid: string | null = null;
  userLuid: string | null = null;

  conversationId: string | null = null;
  scope: string | null = null;
  sdmNames: string[] = [];

  utteranceId: string | null = null;
  conversationTraceId: string | null = null;
  utteranceTraceId: string | null = null;
  utteranceB3TraceId: string | null = null;

  streamedEvents: SseEvent[] = [];
  /** Shared by all phases of one question, including reading the SSE body. */
  questionSignal?: AbortSignal;

  /** Client-owned cookies (seeded after login / child_client). */
  private _cookies = new Map<string, string>();

  constructor(opts: TabCabuClientOptions) {
    this._baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this._loginBaseUrl = (opts.loginBaseUrl ?? opts.baseUrl).replace(/\/+$/, "");
    this._sslVerify = opts.sslVerify ?? false;
    this._caBundlePath = opts.caBundlePath;
    this._fetch = opts.fetchImpl ?? fetch;
    this._uuidHex = opts.uuidHex ?? (() => crypto.randomUUID().replace(/-/g, ""));

    this.username = opts.username ?? null;
    this.password = opts.password ?? null;
    this.sitename = opts.sitename ?? null;
    this.parentLuid = opts.parentLuid ?? "";
  }

  private _seedOwnedCookies(): void {
    this._cookies.set(XSRF_COOKIE_NAME, XSRF_TOKEN_VALUE);
    if (this.authToken) {
      this._cookies.set(WORKGROUP_SESSION_COOKIE_NAME, this.authToken);
    }
  }

  private _cookieHeader(): string {
    return [...this._cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Bun fetch has no cookie jar: retain the service's conversation context.
   * These cookies belong to this client's conversation, not its parent or
   * sibling clients. All CABU phases use the same service base URL.
   */
  private _captureCookies(response: Response, url: string): void {
    if (new URL(url).origin !== new URL(this._baseUrl).origin) return;
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      // Keep the explicit PAT session / paired XSRF value authoritative.
      if (name === WORKGROUP_SESSION_COOKIE_NAME || name === XSRF_COOKIE_NAME) continue;
      const expired = attributes.some((attribute) => {
        const [key, ...value] = attribute.trim().split("=");
        if (key.toLowerCase() === "max-age") return Number(value.join("=")) <= 0;
        if (key.toLowerCase() === "expires") return Date.parse(value.join("=")) <= Date.now();
        return false;
      });
      if (expired) this._cookies.delete(name);
      else this._cookies.set(name, pair.slice(equals + 1).trim());
    }
  }

  private _tlsInit(): { tls?: unknown } {
    // Same TLS ergonomics as TableauSession: sslVerify=false disables the
    // chain, sslVerify=true + caBundlePath trusts a private CA, else system
    // trust. Previously this only handled the verify=false case and ignored a
    // private CA bundle entirely.
    return tlsInit({ verify: this._sslVerify, caBundlePath: this._caBundlePath });
  }

  /** Authenticate with Tableau Cloud and populate auth state. */
  async login(username?: string, password?: string, sitename?: string): Promise<void> {
    if (this.authToken !== null) return;
    const u = username ?? this.username;
    const p = password ?? this.password;
    const s = sitename ?? this.sitename;
    if (!u || !p || !s) {
      throw new Error(
        "Username, password, and sitename must be provided either in constructor or login()",
      );
    }
    const url = `${this._loginBaseUrl}/api/3.4/auth/signin`;
    const body = buildLoginXml(u, p, s);
    let resp: Response;
    resp = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Accept: "*/*" },
      body,
      ...this._tlsInit(),
    });
    this._captureCookies(resp, url);
    if (!resp.ok) {
      const text = await this._safeText(resp);
      throw new CabuHttpError(resp.status, text, "login");
    }
    const text = await resp.text();
    const { token, siteId, userId } = parseLoginXml(text);
    this.authToken = token;
    this.siteLuid = siteId;
    this.userLuid = userId;
    this._seedOwnedCookies();
  }

  /** WAII Phase 1: create a conversation. Returns the conversation id. */
  async createConversation(a: Omit<CreateConversationArgs, "traceId">): Promise<string> {
    const traceId = this._uuidHex();
    this.conversationTraceId = traceId;
    const body = buildCreateConversationBody({ ...a, traceId });
    const url = `${this._baseUrl}/analytics-assistant/cabu/conversations`;
    const resp = await this._fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.analytics-assistant.cabu.conversations.v1.0+json",
        "Content-Type": "application/json",
        Cookie: this._cookieHeader(),
        ...(this.authToken ? { "X-Tableau-Auth": this.authToken } : {}),
      },
      body: JSON.stringify(body),
      signal: this.questionSignal ?? AbortSignal.timeout(120000),
      ...this._tlsInit(),
    });
    this._captureCookies(resp, url);
    if (!resp.ok) {
      throw new CabuHttpError(resp.status, await this._safeText(resp), "createConversation");
    }
    const parsed = parseCreateConversationResponse(await resp.json());
    this.conversationId = parsed.conversationId;
    this.scope = parsed.scope;
    this.sdmNames = parsed.sdmNames;
    return parsed.conversationId;
  }

  /** WAII Phase 2: post the utterance. Returns the utterance id. */
  async postUtterance(a: {
    utterance: string;
    locale?: string;
    language?: string;
    source?: string;
    sessionId?: string | null;
    wgSessionId?: string | null;
    vizqlRoutingKey?: string | null;
  }): Promise<string> {
    if (!this.conversationId) {
      throw new Error("conversation_id must be set before posting an utterance");
    }
    if (!this.scope) {
      throw new Error("scope must be set before posting an utterance");
    }
    const traceId = this._uuidHex();
    this.utteranceTraceId = traceId;
    const body = buildPostUtteranceBody({
      utterance: a.utterance,
      scope: this.scope,
      sdmNames: this.sdmNames,
      parentLuid: this.parentLuid,
      traceId,
      locale: a.locale,
      language: a.language,
      source: a.source,
      sessionId: a.sessionId,
      wgSessionId: a.wgSessionId,
      vizqlRoutingKey: a.vizqlRoutingKey,
    });
    const url =
      `${this._baseUrl}/analytics-assistant/cabu/conversations/` +
      `${this.conversationId}/utterances`;
    const resp = await this._fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.analytics-assistant.cabu.utterances.v1.0+json",
        "Content-Type": "application/json",
        Cookie: this._cookieHeader(),
        ...(this.authToken ? { "X-Tableau-Auth": this.authToken } : {}),
      },
      body: JSON.stringify(body),
      signal: this.questionSignal ?? AbortSignal.timeout(120000),
      ...this._tlsInit(),
    });
    this._captureCookies(resp, url);
    if (!resp.ok) {
      throw new CabuHttpError(resp.status, await this._safeText(resp), "postUtterance");
    }
    const parsed = parsePostUtteranceResponse(await resp.json());
    this.utteranceId = parsed.utteranceId;
    this.utteranceB3TraceId = parsed.b3TraceId;
    return parsed.utteranceId;
  }

  /** WAII Phase 3: stream the SSE response. Returns events in arrival order. */
  async streamConversation(): Promise<SseEvent[]> {
    if (!this.conversationId) {
      throw new Error("conversation_id must be set before streaming");
    }
    if (!this.utteranceId) {
      throw new Error("utterance_id must be set before streaming");
    }
    const url =
      `${this._baseUrl}/analytics-assistant/cabu/conversations/` +
      `${this.conversationId}/utterances/${this.utteranceId}/stream`;
    const resp = await this._fetch(url, {
      method: "GET",
      signal: this.questionSignal ?? AbortSignal.timeout(600000),
      headers: {
        Accept: "text/event-stream",
        "X-XSRF-TOKEN": XSRF_TOKEN_VALUE,
        Cookie: this._cookieHeader(),
        ...(this.authToken ? { "X-Tableau-Auth": this.authToken } : {}),
        ...(this.utteranceB3TraceId ? { "x-b3-traceid": this.utteranceB3TraceId } : {}),
      },
      ...this._tlsInit(),
    });
    this._captureCookies(resp, url);
    if (!resp.ok) {
      throw new CabuHttpError(resp.status, await this._safeText(resp), "streamConversation");
    }
    const text = await resp.text();
    this.streamedEvents = parseSseStream(text);
    return this.streamedEvents;
  }

  /**
   * Return a new client inheriting auth state but with isolated conversation
   * state. Mirrors `child_client()`.
   */
  childClient(): TabCabuServiceClient {
    const child = new TabCabuServiceClient({
      baseUrl: this._baseUrl,
      loginBaseUrl: this._loginBaseUrl,
      username: this.username,
      password: this.password,
      sitename: this.sitename,
      parentLuid: this.parentLuid,
      sslVerify: this._sslVerify,
      caBundlePath: this._caBundlePath,
      fetchImpl: this._fetch,
      uuidHex: this._uuidHex,
    });
    child.authToken = this.authToken;
    child.siteLuid = this.siteLuid;
    child.userLuid = this.userLuid;
    child._seedOwnedCookies();
    return child;
  }

  // -- event convenience accessors (delegate to the pure helpers) ----------

  getFinalAnswer(events?: SseEvent[]): string | null {
    return getFinalAnswer(events ?? this.streamedEvents);
  }
  getError(events?: SseEvent[]): Record<string, unknown> | null {
    return getError(events ?? this.streamedEvents);
  }
  getUtteranceType(events?: SseEvent[]): string | null {
    return getUtteranceType(events ?? this.streamedEvents);
  }
  getGeneratedSql(events?: SseEvent[]): string | null {
    return getGeneratedSql(events ?? this.streamedEvents);
  }
  getDataDetails(events?: SseEvent[]): string | null {
    return getDataDetails(events ?? this.streamedEvents);
  }
  getReasoningText(events?: SseEvent[]): string {
    return getReasoningText(events ?? this.streamedEvents);
  }
  getChatLuid(events?: SseEvent[]): string | null {
    return getChatLuid(events ?? this.streamedEvents);
  }
  getFirstExecutionData(events?: SseEvent[]): Record<string, unknown>[] | null {
    return getFirstExecutionData(events ?? this.streamedEvents);
  }
  getConfidenceScore(events?: SseEvent[]): number | null {
    return getConfidenceScore(events ?? this.streamedEvents);
  }
  getPhaseDurations(events?: SseEvent[]): {
    classification_duration_ms: unknown;
    action_duration_ms: unknown;
  } {
    return getPhaseDurations(events ?? this.streamedEvents);
  }
  getTotalLlmTokens(events?: SseEvent[]): number {
    return getTotalLlmTokens(events ?? this.streamedEvents);
  }
  getLlmCallCount(events?: SseEvent[]): number {
    return getLlmCallCount(events ?? this.streamedEvents);
  }
  getWaiiRequestTraceId(events?: SseEvent[]): string | null {
    return getWaiiRequestTraceId(events ?? this.streamedEvents);
  }

  private async _safeText(resp: Response): Promise<string> {
    try {
      return await resp.text();
    } catch {
      return "";
    }
  }
}
