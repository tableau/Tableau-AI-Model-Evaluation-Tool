/**
 * LLM-judge-based natural-language metrics for the BYOLLM evaluation pipeline.
 *
 *
 * This module:
 *   - Builds a single scoring prompt from (utterance, expected_reply, actual_reply)
 *   - Calls the configured BYOK judge provider natively (providers.ts)
 *   - Parses the JSON response into 0–1 scores
 *   - Returns ComputedMetric-shaped dicts written under `stage="llmJudge"`.
 *
 * Design:
 * - BYOK, provider-native: OpenAI / Anthropic / Gemini reached with the
 *   admin's own API key over real TLS — the ONLY LLM the tool calls directly.
 * - Retries: 3 attempts, exponential 5–30s + 0–2s jitter — mirrors the WAII
 *   client's policy.
 * - Failure mode: after retries, every dimension is emitted with
 *   score=null and an "Unavailable: …" explanation. The run never aborts.
 *   An *unconfigured* judge skips scoring entirely (returns []) — that's
 *   "not requested", not "unavailable".
 */

import { buildRequest, parseResponse, type ChatMessage } from "./providers.ts";

/**
 * Judge metrics get their own stage so the UI and exports can visually
 * separate LLM-judged scores from deterministic ones.
 */
export const JUDGE_STAGE = "llmJudge";
export const JUDGE_METRIC_ID = "NLJudge";

/**
 * Metric names emitted by the judge. The frontend `METRIC_BUCKETS.nl` must
 * include these names for them to surface in the NL card.
 */
export const JUDGE_METRIC_NAMES = [
  "coherence",
  "insightfulness",
  "factualGrounding",
  "followUpRelevance",
] as const;

/**
 * A calculation's explanation is judged on fewer dimensions: it is meant to
 * say what the formula does, not to find trends or invite a follow-up
 */
export const CALC_JUDGE_METRIC_NAMES = ["coherence", "factualGrounding"] as const;

/**
 * Default judge model. Picked because gpt-4o is widely available across
 * gateways.
 */
export const DEFAULT_JUDGE_MODEL = "gpt-4o";

/**
 * Conservative timeout — a single scoring call should land in <10s on any
 * reasonable gateway.
 */
export const DEFAULT_TIMEOUT_S = 30.0;
/**
 * Room for the judge's answer. 400 was enough for gpt-4.1 and gpt-6-luna
 * (about 200 tokens of scores and one-line reasons), but claude-opus-5-5
 * writes about 900 for the same prompt, and a cut-off answer is not JSON:
 * A truncated answer cannot be parsed into scores.
 */
export const JUDGE_MAX_TOKENS = 1500;

export interface ComputedMetric {
  metric_id: string;
  metric_name: string;
  score: number | null;
  explanation: string | null;
}

export interface JudgeConfig {
  provider?: string;
  api_key?: string;
  model?: string;
  timeout_s?: number;
}

export interface JudgeInput {
  utterance: string;
  expectedReply?: string | null;
  actualReply?: string | null;
  expectedSpec?: Record<string, unknown> | null;
  judgeCfg: JudgeConfig;
  /** A calculated-field answer's formulas: the case gets the calculation rubric. */
  expectedFormula?: string | null;
  calculationCase?: boolean;
  actualFormula?: string | null;
}

/**
 * Retry policy knobs. Mirrors tenacity's
 * `wait_exponential(multiplier=1, min=5, max=30) + wait_random(0, 2)` with
 * `stop_after_attempt(3)`. Injectable so tests don't wait 30s.
 */
export interface RetryPolicy {
  attempts: number;
  /** Compute the wait (ms) before the retry that follows a failed attempt N (1-based). */
  waitMs: (attemptNumber: number) => number;
  /** Sleep helper (injectable for tests). */
  sleep: (ms: number) => Promise<void>;
}

const _sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * tenacity parity: exponential 5–30s (multiplier=1, min=5, max=30) + 0–2s
 * jitter. tenacity's `wait_exponential(multiplier=m, min, max)` yields
 * `min(max, max(min, m * 2**(attempt-1)))` seconds before the retry that
 * follows attempt `attempt`.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  waitMs: (attemptNumber: number) => {
    const expSeconds = Math.min(30, Math.max(5, 1 * 2 ** (attemptNumber - 1)));
    const jitterSeconds = Math.random() * 2;
    return (expSeconds + jitterSeconds) * 1000;
  },
  sleep: _sleep,
};

/**
 * The prompt for a calculated-field answer: the judge sees the request, the
 * expected formula and the model's formula, and rates the model's explanation
 * on whether it describes that formula truthfully and reads well. Insight and
 * follow-ups are not what an explanation is for.
 */
export function buildCalcPrompt(
  utterance: string,
  expectedReply: string,
  actualReply: string,
  expectedFormula: string | null | undefined,
  actualFormula: string | null | undefined,
): string {
  return `You are an evaluator scoring the explanation a model wrote for a Tableau calculated field it created.

User request:
${utterance}

Expected formula (the reference answer):
${expectedFormula || "(none provided)"}

The model's formula:
${actualFormula || "(no formula produced)"}

The model's explanation of its formula:
${actualReply || "(no explanation produced)"}
${expectedReply ? `Reference explanation:\n${expectedReply}` : ""}

Score the explanation on each of the following dimensions, returning a number between 0.0 (worst) and 1.0 (best), plus a brief one-sentence reason that justifies the score:

- coherence: Is the explanation well-organized, fluent, and easy to follow for a Tableau user?
- factualGrounding: Does the explanation describe what the model's formula actually does (its fields, functions, conditions and result), and does that formula address the user's request as the expected formula does? Penalize claims the formula does not back, fields or values it does not use, and silence about what it does differently from the expected formula.

If the model produced no explanation at all, score every dimension 0.0 and give "No explanation produced." as the reason.

Respond with ONLY a single JSON object — no surrounding prose, no code fences. Each dimension is an object with \`score\` (number 0..1) and \`reason\` (≤140 chars, plain text). Example shape:
{"coherence": {"score": 0.9, "reason": "Clear two-sentence description."}, "factualGrounding": {"score": 0.6, "reason": "Says it counts opportunities but the formula sums Amount."}}
`;
}

/**
 * Construct the judge scoring prompt.
 *
 * A single prompt scores all four dimensions in one round-trip. The
 * instructions are explicit about the JSON shape so a strong judge returns
 * parseable output without needing a function-calling schema.
 */
export function buildPrompt(
  utterance: string,
  expectedReply: string,
  actualReply: string,
  expectedSpec?: Record<string, unknown> | null,
): string {
  // Spec context helps when the test case has no NL reply (viz-authoring
  // cases). Without it, the judge has nothing to ground "factualGrounding"
  // against.
  let specBlob = "";
  if (expectedSpec) {
    try {
      specBlob =
        "\nExpected visualization specification (for grounding):\n" +
        JSON.stringify(expectedSpec, null, 2).slice(0, 1500);
    } catch {
      specBlob = "";
    }
  }

  return `You are an evaluator scoring a model's natural-language response to a Tableau analytical question.

User question:
${utterance}

Reference (expected) reply:
${expectedReply || "(none provided)"}

Model's actual reply:
${actualReply || "(no reply produced)"}
${specBlob}

Score the model's reply on each of the following dimensions, returning a number between 0.0 (worst) and 1.0 (best), plus a brief one-sentence reason that justifies the score:

- coherence: Is the reply well-organized, fluent, and easy to follow?
- insightfulness: Does it reveal meaningful patterns, comparisons, or implications about the data, beyond restating the question?
- factualGrounding: Do the claims align with the user's question and the reference reply / expected spec? Penalize hallucinated fields, values, or relationships.
- followUpRelevance: Would this reply naturally enable a useful follow-up question, or does it close off the conversation?

If the model produced no reply at all, score every dimension 0.0 and give "No reply produced." as the reason.

Respond with ONLY a single JSON object — no surrounding prose, no code fences. Each dimension is an object with \`score\` (number 0..1) and \`reason\` (≤140 chars, plain text). Example shape:
{"coherence": {"score": 0.82, "reason": "Logical flow with one awkward transition."}, "insightfulness": {"score": 0.45, "reason": "Restates fields without highlighting trends."}, "factualGrounding": {"score": 0.90, "reason": "All cited fields appear in the spec."}, "followUpRelevance": {"score": 0.60, "reason": "Suggests breakdown but doesn't invite a question."}}
`;
}

/**
 * Regex to find the first {...} JSON object in a string. The judge sometimes
 * wraps its answer in prose despite the prompt — this is the cheapest way to
 * recover a parseable payload without re-prompting.
 *
 * JS `[^{}]` already
 * spans newlines, so no `s` flag is needed for equivalence.
 */
const _JSON_OBJ_RE = /\{[^{}]*\}/;

/**
 * Extract the scores dict from a judge response.
 *
 * Tolerates code-fenced JSON, leading prose, and trailing prose. Returns an
 * empty object if no parseable object is found — the caller handles that as
 * "skip these metrics".
 */
export function parseJudgeResponse(text: string): Record<string, unknown> {
  if (!text) {
    return {};
  }
  // Strip code fences if present.
  let cleaned = text.replace(/```(?:json)?\s*/g, "");
  cleaned = cleaned.replace(/```/g, "");
  // Try direct parse first (fast path when the judge follows instructions).
  try {
    const obj = JSON.parse(cleaned.trim());
    if (isPlainObject(obj)) {
      return obj;
    }
  } catch {
    // fall through
  }
  // Fall back to first {...} block.
  const m = _JSON_OBJ_RE.exec(cleaned);
  if (!m) {
    return {};
  }
  try {
    const obj = JSON.parse(m[0]);
    return isPlainObject(obj) ? obj : {};
  } catch {
    return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Clamp a value to [0,1] or return null if it isn't a number. */
export function coerceScore(v: unknown): number | null {
  // Mirror Python float(): accept numbers and numeric strings, reject the rest.
  let f: number;
  if (typeof v === "number") {
    f = v;
  } else if (typeof v === "string" && v.trim() !== "") {
    f = Number(v);
  } else if (typeof v === "boolean") {
    // Python float(True)==1.0; JS Number(true)==1. Keep parity.
    f = Number(v);
  } else {
    return null;
  }
  if (Number.isNaN(f)) {
    return null;
  }
  return Math.max(0.0, Math.min(1.0, f));
}

/** Transient judge-call failure (network, 5xx, 429) — worth retrying. */
export class RetryableJudgeError extends Error {}

/** Non-retryable judge-call failure (bad key/model — 401/403/404 etc.). */
export class NonRetryableJudgeError extends Error {}

/**
 * fetch implementation injectable for tests. Defaults to the global fetch
 * (Bun/global).
 */
export type FetchFn = typeof fetch;

/**
 * One provider-native scoring call. Throws RetryableJudgeError on transient
 * failures so the retry loop can retry; throws NonRetryableJudgeError on
 * non-retryable ones (bad key/model).
 */
async function postOnce(
  provider: string,
  model: string,
  apiKey: string,
  prompt: string,
  timeoutS: number,
  fetchFn: FetchFn,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are a precise evaluator. Respond with strict JSON only.",
    },
    { role: "user", content: prompt },
  ];
  const { url, headers, query, body } = buildRequest(
    provider,
    model,
    apiKey,
    messages,
    JUDGE_MAX_TOKENS,
    0.0,
  );

  const target = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    target.searchParams.set(k, v);
  }

  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
    try {
      resp = await fetchFn(target.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (exc) {
    // Network error / timeout (abort) → retryable, mirroring httpx.HTTPError.
    throw new RetryableJudgeError(`network error: ${String(exc)}`);
  }

  if (resp.status === 429 || resp.status >= 500) {
    const text = (await safeText(resp)).slice(0, 200);
    throw new RetryableJudgeError(`HTTP ${resp.status}: ${text}`);
  }
  if (resp.status >= 400) {
    // 401/403/404 etc. — retrying won't help; surface immediately.
    const text = (await safeText(resp)).slice(0, 200);
    throw new NonRetryableJudgeError(`HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const answer = parseResponse(provider, data);
  if (!answer.trim()) throw new RetryableJudgeError("empty answer from the evaluator model");
  return answer;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * Call the judge with retries (3 attempts, exp 5–30s + 0–2s jitter —
 * bounded retries). Throws on final failure; the caller maps that
 * to per-case "Unavailable" scores. Only RetryableJudgeError triggers a
 * retry; NonRetryableJudgeError propagates immediately (tenacity
 * `retry_if_exception_type(_RetryableJudgeError)` semantics).
 *
 * Exported as the shared retry/provider machinery so sibling judges (e.g. the colour-palette
 * judge, palette_judge.ts) reuse the exact same call path.
 */
export async function callJudge(args: {
  provider: string;
  model: string;
  apiKey: string;
  prompt: string;
  timeoutS: number;
  fetchFn: FetchFn;
  retry: RetryPolicy;
}): Promise<string> {
  const { provider, model, apiKey, prompt, timeoutS, fetchFn, retry } = args;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    try {
      return await postOnce(provider, model, apiKey, prompt, timeoutS, fetchFn);
    } catch (exc) {
      lastErr = exc;
      // Non-retryable errors reraise immediately.
      if (!(exc instanceof RetryableJudgeError)) {
        throw exc;
      }
      // If this was the last attempt, reraise (tenacity reraise=True).
      if (attempt >= retry.attempts) {
        throw exc;
      }
      await retry.sleep(retry.waitMs(attempt));
    }
  }
  // Unreachable; satisfies type checkers.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Build a ComputedMetric-shaped dict matching viz_quality_metrics._entry.
 *
 * `score=null` means "Unavailable": the judge was requested but
 * could not score this case. Null scores are excluded from averages.
 */
function toMetricEntry(
  name: string,
  score: number | null,
  explanation: string | null = null,
): ComputedMetric {
  return {
    metric_id: JUDGE_METRIC_ID,
    metric_name: name,
    score: score === null ? null : Math.max(0.0, Math.min(1.0, score)),
    explanation,
  };
}

function unavailableEntries(
  reason: string,
  names: readonly string[] = JUDGE_METRIC_NAMES,
): ComputedMetric[] {
  const msg = `Unavailable: ${reason}`.slice(0, 200);
  return names.map((name) => toMetricEntry(name, null, msg));
}

/**
 * Compute LLM-judge NL metrics for a single test case.
 *
 * Returns a list of ComputedMetric-shaped dicts (one per dimension) that the
 * caller appends to `test_case.result.metrics[JUDGE_STAGE]`. Never throws: an
 * unconfigured judge returns [] (not requested); a configured judge that
 * fails returns "Unavailable" entries.
 */
export async function computeJudgeMetrics(
  input: JudgeInput,
  opts: { fetchFn?: FetchFn; retry?: RetryPolicy } = {},
): Promise<ComputedMetric[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const retry = opts.retry ?? DEFAULT_RETRY_POLICY;

  const cfg = input.judgeCfg ?? {};
  const provider = cfg.provider ?? "";
  const apiKey = cfg.api_key ?? "";
  if (!provider || !apiKey) {
    // Judge metrics skipped: judge not configured.
    return [];
  }

  const utterance = input.utterance ?? "";
  const actualReply = input.actualReply ?? "";
  // No utterance and no actual reply means nothing to score — bail before
  // spending a token.
  if (!(utterance || actualReply)) {
    return [];
  }

  // A calculated-field answer gets the calculation rubric (two dimensions,
  // grounded in the formulas); everything else the reply rubric (four
  // dimensions, grounded in the expected chart).
  const calcCase = Boolean(input.calculationCase || input.expectedFormula || input.actualFormula);
  const names: readonly string[] = calcCase ? CALC_JUDGE_METRIC_NAMES : JUDGE_METRIC_NAMES;
  const prompt = calcCase
    ? buildCalcPrompt(
        utterance,
        input.expectedReply ?? "",
        actualReply,
        input.expectedFormula,
        input.actualFormula,
      )
    : buildPrompt(utterance, input.expectedReply ?? "", actualReply, input.expectedSpec ?? undefined);

  let raw: string;
  try {
    raw = await callJudge({
      provider,
      model: cfg.model || DEFAULT_JUDGE_MODEL,
      apiKey,
      prompt,
      timeoutS: cfg.timeout_s ?? DEFAULT_TIMEOUT_S,
      fetchFn,
      retry,
    });
  } catch (exc) {
    // Judge call failed after retries.
    return unavailableEntries(String(exc instanceof Error ? exc.message : exc), names);
  }

  const scores = parseJudgeResponse(raw);
  if (Object.keys(scores).length === 0) {
    // Judge response did not contain parseable JSON.
    return unavailableEntries("judge returned unparseable output", names);
  }

  // Each dimension is now { score, reason }. Tolerate the older shape where
  // the value was a bare number.
  const out: ComputedMetric[] = [];
  for (const name of names) {
    const rawVal = scores[name];
    let scoreVal: number | null = null;
    let reason: string | null = null;
    if (isPlainObject(rawVal)) {
      scoreVal = coerceScore(rawVal.score);
      const r = rawVal.reason;
      if (typeof r === "string" && r.trim()) {
        reason = r.trim().slice(0, 200); // cap length to keep tooltip readable
      }
    } else {
      scoreVal = coerceScore(rawVal);
    }
    if (scoreVal !== null) {
      out.push(toMetricEntry(name, scoreVal, reason));
    }
  }
  return out;
}
