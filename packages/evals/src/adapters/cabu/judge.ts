/**
 * CABU LLM-judge metrics for the tool's BYOK judge.
 *
 * Scoring semantics:
 *   - 0-10 scale normalized to 0-1 (`denominator=10`);
 *   - both-empty answers short-circuit to 1.0 before any LLM call;
 *   - a judge failure yields score=null ("Unavailable", excluded from
 *     averages) — the tool's unavailable-score convention, applied per metric.
 *
 * Beside answer correctness and factual consistency, the Concierge judges the
 * CABU run configs enable: `coherence_dashboard_qa` reads the prose
 * `expected_answer` as its ground truth ("None" when there is none) and takes
 * the best score over `|`-separated truths; `relevance_dashboard_qa` reads the
 * case's `output_type` (SQ, Clarify Intent, Unsupported) and `answer_source`,
 * and scores each `, `-separated type (the best one counts).
 *
 * The actual provider call is behind an injectable `JudgeCaller` seam. Tests inject a fake caller; a later wiring can route to the
 * ported judge providers.
 */

import {
  ANSWER_CORRECTNESS_TEMPLATE,
  COHERENCE_DASHBOARD_QA_TEMPLATE,
  FACTUAL_CONSISTENCY_TEMPLATE,
  RELEVANCE_DASHBOARD_QA_TEMPLATE,
} from "./templates.ts";
import type { MetricEntry } from "@tableau-ai-eval/core";

export const CABU_JUDGE_METRIC_ID = "CabuJudge";
export const CABU_STAGE = "llmJudge";

/**
 * Reproduce Python `str.format(**kwargs)` for our templates: `{{` → `{`,
 * `}}` → `}`, and `{name}` → the mapped value. Unlike full str.format we only
 * support simple named fields (which is all the CABU templates use).
 */
export function formatTemplate(template: string, values: Record<string, string>): string {
  let out = "";
  let i = 0;
  const n = template.length;
  while (i < n) {
    const ch = template[i]!;
    if (ch === "{") {
      if (template[i + 1] === "{") {
        out += "{";
        i += 2;
        continue;
      }
      const end = template.indexOf("}", i + 1);
      if (end === -1) {
        // Unbalanced brace — emit literally (defensive).
        out += ch;
        i += 1;
        continue;
      }
      const name = template.slice(i + 1, end);
      out += name in values ? values[name]! : "";
      i = end + 1;
    } else if (ch === "}") {
      if (template[i + 1] === "}") {
        out += "}";
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

export function buildAnswerCorrectnessPrompt(
  question: string,
  observedAnswer: string,
  expectedAnswer: string,
): string {
  return formatTemplate(ANSWER_CORRECTNESS_TEMPLATE, {
    question: question || "",
    observed_answer: observedAnswer || "",
    expected_answer: expectedAnswer || "",
  });
}

export function buildFactualConsistencyPrompt(
  question: string,
  response: string,
  groundTruthAnswer: string,
  queryResponseData: unknown,
): string {
  let qrd: string;
  if (typeof queryResponseData === "string") {
    qrd = queryResponseData;
  } else {
    try {
      qrd = JSON.stringify(queryResponseData).slice(0, 8000);
    } catch {
      qrd = String(queryResponseData).slice(0, 8000);
    }
  }
  return formatTemplate(FACTUAL_CONSISTENCY_TEMPLATE, {
    question: question || "",
    response: response || "",
    ground_truth_answer: groundTruthAnswer || "",
    query_response_data: qrd || "[]",
  });
}

export function buildCoherencePrompt(question: string, answer: string, groundTruth: string): string {
  return formatTemplate(COHERENCE_DASHBOARD_QA_TEMPLATE, {
    question: question || "",
    answer: answer || "",
    ground_truth: groundTruth ? groundTruth : "None",
  });
}

export function buildRelevancePrompt(
  question: string,
  answer: string,
  expectedOutputType: string,
  answerSource: string,
): string {
  return formatTemplate(RELEVANCE_DASHBOARD_QA_TEMPLATE, {
    question: question || "",
    answer: answer || "",
    expected_output_type: expectedOutputType || "SQ",
    answer_source: answerSource || "ANSWER_SOURCE_SEMANTIC_QUERY",
  });
}

/**
 * Extract (score01, explanation) from the judge's reply. Mirrors
 * `parse_judge_json`: try fenced JSON, then bare text, then first-{...} object;
 * normalize a 0-10 `score` to 0-1; null score → "Unavailable" reason.
 */
export function parseJudgeJson(text: string): {
  score: number | null;
  explanation: string | null;
} {
  if (!text) return { score: null, explanation: "empty judge response" };
  const stripped = text.trim();
  const candidates: string[] = [];

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(stripped);
  if (fence) candidates.push(fence[1]!);
  candidates.push(stripped);
  const greedy = /\{[\s\S]*\}/.exec(stripped);
  if (greedy) candidates.push(greedy[0]);
  const lazy = /\{[\s\S]*?\}/.exec(stripped);
  if (lazy) candidates.push(lazy[0]);

  for (const cand of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(cand);
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const obj = data as Record<string, unknown>;
    if (!("score" in obj)) continue;
    const rawScore = obj.score;
    let raw: number;
    if (typeof rawScore === "number") {
      raw = rawScore;
    } else if (typeof rawScore === "string" && rawScore.trim() !== "") {
      raw = Number(rawScore);
    } else if (typeof rawScore === "boolean") {
      raw = Number(rawScore);
    } else {
      return { score: null, explanation: "non-numeric score in judge response" };
    }
    if (Number.isNaN(raw)) {
      return { score: null, explanation: "non-numeric score in judge response" };
    }
    const score = Math.max(0.0, Math.min(1.0, raw / 10.0));
    const explanation = typeof obj.explanation === "string" ? obj.explanation : null;
    return { score, explanation };
  }
  return { score: null, explanation: `unparseable judge response: ${text.slice(0, 120)}` };
}

function entry(name: string, score: number | null, explanation: string | null): MetricEntry {
  return {
    metric_id: CABU_JUDGE_METRIC_ID,
    metric_name: name,
    score,
    explanation,
  };
}

export interface CabuJudgeConfig {
  provider?: string;
  model?: string;
  api_key?: string;
}

/**
 * The injectable judge-call seam. Returns the raw judge text. Mirrors
 * `nlq_eval_judge._call_judge` (provider routing + retry live behind it).
 */
export type JudgeCaller = (args: {
  provider: string;
  model: string;
  apiKey: string;
  prompt: string;
  timeoutS: number;
}) => Promise<string>;

/**
 * Score one CABU case with the BYOK judge. Never throws: judge failures produce
 * score=null ("Unavailable") entries per metric. Mirrors
 * `compute_cabu_judge_metrics`.
 */
// The rubric's own words for a question whose right answer is not data: a
// clarification, a refusal, or "no such thing in the data". Those are judged
// without query rows; a data answer is not.
const DATA_NOT_EXPECTED_RE =
  /clarification needed|requires clarification|not enough information|not available|not present|^\s*NA\s*$|unable to|incapable of|out of scope|not supported|no data|not found|no records|does not exist/i;
export const ROWS_UNKNOWN_REASON =
  "Unavailable: the server sent neither the query rows nor the query behind this answer (its " +
  "Dashboard Q&A debug context is off for this site; the ECT_Dev feature flag turns it on), so " +
  "whether the answer is faithful to the data cannot be judged.";

export function dataNotExpected(expectedAnswer: string | null | undefined): boolean {
  return DATA_NOT_EXPECTED_RE.test(expectedAnswer || "");
}

/**
 * Whether the server showed what its query returned: rows, or the query and
 * its debug context (LLM calls, tokens). A site with the debug context off
 * sends none of these for a scalar answer, and then the factual consistency
 * judge cannot tell "no rows" from "rows not sent".
 */
export function rowsKnown(o: {
  query_response_data?: unknown;
  semantic_query?: unknown;
  llm_calls?: unknown;
  total_tokens?: unknown;
}): boolean {
  return (
    (Array.isArray(o.query_response_data) && o.query_response_data.length > 0) ||
    Boolean(o.semantic_query) ||
    Boolean(o.llm_calls) ||
    Boolean(o.total_tokens)
  );
}

export async function computeCabuJudgeMetrics(args: {
  question: string;
  observedAnswer: string;
  expectedAnswer: string;
  queryResponseData: unknown;
  judgeCfg: CabuJudgeConfig;
  callJudge: JudgeCaller;
  timeoutS?: number;
  /** The case's prose `expected_answer` (coherence's ground truth). */
  expectedProse?: string | null;
  /** The case's `output_type` (relevance), default "SQ". */
  outputType?: string | null;
  /** The case's `answer_source` (relevance), default the semantic query. */
  answerSource?: string | null;
  /** Whether the server showed what its query returned (rows, or the query
   *  and its debug context). False → a data answer's factual consistency is
   *  Unavailable rather than the rubric's 0 for "no rows" (2026-10-21). */
  rowsKnown?: boolean;
}): Promise<MetricEntry[]> {
  const {
    question,
    observedAnswer,
    expectedAnswer,
    queryResponseData,
    judgeCfg,
    callJudge,
    timeoutS = 60.0,
    expectedProse,
    outputType,
    answerSource,
    rowsKnown: known = true,
  } = args;

  const provider = judgeCfg.provider ?? "";
  const model = judgeCfg.model ?? "";
  const apiKey = judgeCfg.api_key ?? "";

  const entries: MetricEntry[] = [];

  // -- answerCorrectness --------------------------------------------------
  const bothEmpty =
    (!expectedAnswer || expectedAnswer === "None") &&
    (!observedAnswer || observedAnswer === "None");
  if (bothEmpty) {
    entries.push(entry("answerCorrectness", 1.0, "Both expected and observed empty"));
  } else {
    try {
      const text = await callJudge({
        provider,
        model,
        apiKey,
        prompt: buildAnswerCorrectnessPrompt(question, observedAnswer, expectedAnswer),
        timeoutS,
      });
      const { score, explanation } = parseJudgeJson(text);
      const reason = score !== null ? explanation : `Unavailable: ${explanation}`;
      entries.push(entry("answerCorrectness", score, reason));
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      entries.push(entry("answerCorrectness", null, `Unavailable: ${msg}`.slice(0, 200)));
    }
  }

  // -- factualConsistency (needs executed data to check against) ----------
  const noRows = !Array.isArray(queryResponseData) || queryResponseData.length === 0;
  if (!known && noRows && !dataNotExpected(expectedAnswer)) {
    entries.push(entry("factualConsistency", null, ROWS_UNKNOWN_REASON));
  } else if (queryResponseData) {
    try {
      const text = await callJudge({
        provider,
        model,
        apiKey,
        prompt: buildFactualConsistencyPrompt(
          question,
          observedAnswer,
          expectedAnswer,
          queryResponseData,
        ),
        timeoutS,
      });
      const { score, explanation } = parseJudgeJson(text);
      const reason = score !== null ? explanation : `Unavailable: ${explanation}`;
      entries.push(entry("factualConsistency", score, reason));
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      entries.push(entry("factualConsistency", null, `Unavailable: ${msg}`.slice(0, 200)));
    }
  }

  const judgeOnce = async (prompt: string): Promise<{ score: number; explanation: string | null }> => {
    const text = await callJudge({ provider, model, apiKey, prompt, timeoutS });
    const { score, explanation } = parseJudgeJson(text);
    if (score === null) throw new Error(explanation || "unparseable judge response");
    return { score, explanation };
  };

  // -- coherence_dashboard_qa (best score over |-separated truths) --------
  const truths = (expectedProse || "").split("|");
  try {
    let best: { score: number; explanation: string | null } | null = null;
    for (const truth of truths) {
      const got = await judgeOnce(buildCoherencePrompt(question, observedAnswer, truth.trim()));
      if (best === null || got.score > best.score) best = got;
    }
    entries.push(entry("coherence_dashboard_qa", best!.score, best!.explanation));
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    entries.push(entry("coherence_dashboard_qa", null, `Unavailable: ${msg}`.slice(0, 200)));
  }

  // -- relevance_dashboard_qa (one call per expected output type) ---------
  let types = (outputType || "SQ")
    .split(", ")
    .map((t) => t.trim())
    .filter((t) => t);
  if (types.length === 0) types = ["SQ"];
  try {
    const scores: number[] = [];
    const notes: string[] = [];
    for (const expectedType of types) {
      const got = await judgeOnce(
        buildRelevancePrompt(
          question,
          observedAnswer,
          expectedType,
          answerSource || "ANSWER_SOURCE_SEMANTIC_QUERY",
        ),
      );
      scores.push(got.score);
      if (got.explanation) notes.push(got.explanation);
    }
    entries.push(entry("relevance_dashboard_qa", Math.max(...scores), notes.join("; ") || null));
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    entries.push(entry("relevance_dashboard_qa", null, `Unavailable: ${msg}`.slice(0, 200)));
  }

  return entries;
}
