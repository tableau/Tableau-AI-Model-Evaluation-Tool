/**
 * Prep bench context → orchestrator row payload, and the tool's own Prep
 * scores.
 * Includes formula/plan/intent metrics and expected-answer serialization.
 */

import type { MetricEntry, RowError, RowPayload } from "@tableau-ai-eval/core";
import { dataName, isStepList, type PrepRecord, type SuiteKind } from "./bench.ts";
import { intentExplanation } from "./intent.ts";
import { SequenceMatcher } from "./sequence_matcher.ts";

export const GENERATOR_STAGE: Record<SuiteKind, string> = {
  "calc-gen": "calc_generator",
  "flow-plan-gen": "flow_plan_generator",
  "intent-gen": "intent_generator",
};

/** A flow plan is scored by this module, step by step; it has no bench scorer. */
export const SCORER_STAGE: Partial<Record<SuiteKind, string>> = {
  "calc-gen": "calc_scorer",
  "intent-gen": "intent_scorer",
};

/**
 * The key each generator stage stores its parsed answer under. A generator
 * entry without it means the request itself failed (the bench records only
 * the response body then).
 */
export const OUTPUT_KEY: Record<SuiteKind, string> = {
  "calc-gen": "actual-calc",
  "flow-plan-gen": "flow-plan",
  "intent-gen": "intent-detected",
};

/**
 * The metric that carries a zero when the model answered but the answer could
 * not be read: [stage, metric_id, metric_name]. Intent has none: its answer is
 * taken as plain text and always reads.
 */
const UNREADABLE_METRIC: Partial<Record<SuiteKind, [string, string, string]>> = {
  "calc-gen": ["calculatedFieldFormula", "PrepCalcGrammar", "calcValidity"],
  "flow-plan-gen": ["flowPlan", "PrepFlowPlanSimilarity", "planSimilarity"],
};

/** Cap for stashing the raw generation into debug_info (bloat guard). */
export const DEBUG_GENERATION_CAP = 4000;

export function expectedDict(kind: SuiteKind, rec: PrepRecord): Record<string, unknown> {
  if (kind === "calc-gen") return { calculation: rec["expected-calc"] ?? null };
  if (kind === "flow-plan-gen") return { flowPlan: rec["expected-flow-plan"] ?? null };
  return { intent: rec["expected-intent"] ?? null };
}

type Entry = Record<string, unknown>;
const isObj = (v: unknown): v is Entry => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The bench records stage exceptions as `detail_exception()` dicts:
 * `{message: "Exception ...", location: "file:line"}`. A generator that fails
 * after its request was built merges that dict with its usual context
 * (prompt, model parameters, the raw generation), so other keys may sit
 * beside the two.
 */
export function isExceptionEntry(entry: unknown): entry is Entry & { message: string } {
  if (!isObj(entry) || typeof entry.message !== "string") return false;
  if (Object.keys(entry).every((k) => k === "message" || k === "location")) return true;
  return "location" in entry && entry.message.startsWith("Exception ");
}

/** The bench's `detail_exception()` shape for an error raised in the tool. */
export function detailException(exc: unknown, location: string): { message: string; location: string } {
  const name = exc instanceof SyntaxError ? "JSONDecodeError" : exc instanceof Error ? exc.constructor.name : "Exception";
  const msg = exc instanceof Error ? exc.message : String(exc);
  return { message: `Exception ${name}: ${msg}`, location };
}

/** Python `json.loads(s)` is a dict. */
function parsesToObject(s: string): boolean {
  try {
    return isObj(JSON.parse(s));
  } catch {
    return false;
  }
}

/**
 * The JSON object inside a reply that wraps it in other text. Fenced blocks
 * are tried last to first (the final answer comes last), then the outermost
 * braces. Returns the object's text, or null when the reply holds no JSON
 * object.
 */
export function extractJsonObject(text: string): string | null {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  candidates.reverse();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && first < last) candidates.push(text.slice(first, last + 1));
  for (const raw of candidates) {
    const c = raw.trim();
    if (parsesToObject(c)) return c;
  }
  return null;
}

/**
 * Give a generator whose answer failed to parse a second reading: when the
 * raw reply holds a JSON object wrapped in other text, parse that object with
 * the stage's own parser and mark the entry. Returns whether the stage now
 * counts as succeeded.
 */
export function recoverWrappedJson(
  stageName: string,
  parse: (generation: string) => Entry,
  context: Record<string, unknown>,
): boolean {
  const entry = context[stageName];
  if (!isExceptionEntry(entry)) return false;
  const generation = entry.generation;
  if (typeof generation !== "string") return false;
  const extracted = extractJsonObject(generation);
  if (extracted === null || extracted === generation.trim()) return false;
  let parsed: Entry;
  try {
    parsed = parse(extracted);
  } catch {
    return false;
  }
  const recovered: Entry = {};
  for (const [k, v] of Object.entries(entry)) if (k !== "message" && k !== "location") recovered[k] = v;
  Object.assign(recovered, parsed, { "json-extracted": true });
  context[stageName] = recovered;
  return true;
}

/** The step names of the model's plan, in order (`functions[].functionName`). */
export function planStepNames(plan: unknown): string[] {
  const functions = isObj(plan) ? (Array.isArray(plan.functions) ? plan.functions : plan.steps) : null;
  if (!Array.isArray(functions)) return [];
  return functions
    .filter((f): f is Entry => isObj(f) && typeof f.functionName === "string")
    .map((f) => f.functionName as string);
}

/** Python `Counter` arithmetic on step names. */
function counts(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** Elements of `a` minus the shared counts, in `a`'s first-seen order (Counter.elements()). */
function minus(a: string[], shared: Map<string, number>): string[] {
  const ca = counts(a);
  const out: string[] = [];
  for (const [k, n] of ca) for (let i = 0; i < n - (shared.get(k) ?? 0); i++) out.push(k);
  return out;
}

/**
 * Score a planned list of steps against the expected one, step by step:
 * planSimilarity (2 x matching steps in order / (expected + planned)),
 * stepRecall (share of the expected steps the plan contains, in any order)
 * and stepPrecision (share of the planned steps that were expected).
 */
export function flowPlanMetrics(expected: string[], actual: string[], accepted?: unknown): MetricEntry[] {
  let best = planMetrics(expected, actual);
  for (const alternative of Array.isArray(accepted) ? accepted : []) {
    if (!isStepList(alternative)) continue;
    const candidate = planMetrics(alternative, actual);
    const better =
      candidate[0].score! > best[0].score! ||
      (candidate[0].score === best[0].score && (candidate[1].score ?? 0) > (best[1].score ?? 0));
    if (better) {
      const prefix = `Compared with the accepted alternative plan (${alternative.join(", ")}): `;
      best = candidate.map(m => ({ ...m, explanation: prefix + m.explanation }));
    }
  }
  return best;
}

/** The three metrics against one plan: the expected one, or an accepted alternative. */
function planMetrics(expected: string[], actual: string[]): MetricEntry[] {
  const matcher = new SequenceMatcher(expected, actual);
  const inOrder = matcher.getMatchingBlocks().reduce((s, [, , size]) => s + size, 0);
  const total = expected.length + actual.length;
  const ce = counts(expected);
  const ca = counts(actual);
  const shared = new Map<string, number>();
  for (const [k, n] of ce) {
    const m = Math.min(n, ca.get(k) ?? 0);
    if (m > 0) shared.set(k, m);
  }
  const common = [...shared.values()].reduce((s, n) => s + n, 0);
  const missing = minus(expected, shared);
  const extra = minus(actual, shared);
  const listed = (names: string[]) => names.join(", ");

  let precisionNote: string;
  if (!actual.length) precisionNote = "The plan has no steps.";
  else if (extra.length)
    precisionNote = `${common} of ${actual.length} planned steps were expected. Not expected: ${listed(extra)}.`;
  else precisionNote = `All ${actual.length} planned steps were expected.`;
  return [
    {
      metric_id: "PrepFlowPlanSimilarity",
      metric_name: "planSimilarity",
      score: total ? (2 * inOrder) / total : 1.0,
      explanation: `${inOrder} steps match in order (${expected.length} expected, ${actual.length} planned).`,
    },
    {
      metric_id: "PrepFlowPlanStepRecall",
      metric_name: "stepRecall",
      score: expected.length ? common / expected.length : null,
      explanation:
        `${common} of ${expected.length} expected steps are in the plan.` +
        (missing.length ? ` Missing: ${listed(missing)}.` : ""),
    },
    {
      metric_id: "PrepFlowPlanStepPrecision",
      metric_name: "stepPrecision",
      score: actual.length ? common / actual.length : 0.0,
      explanation: precisionNote,
    },
  ];
}

/**
 * Calculation Validity and Formula Similarity from the bench scorer's
 * verdict. A case that expects no formula scores the model on declining: a
 * formula written where none was expected fails, and similarity is left out.
 */
export function calcMetrics(rec: PrepRecord, gen: Entry, score: Entry): MetricEntry[] {
  const e = rec["expected-calc"];
  const expected = typeof e === "string" ? e.trim() : "";
  const a = gen["actual-calc"];
  const actual = typeof a === "string" ? a.trim() : "";
  const validity: MetricEntry = { metric_id: "PrepCalcGrammar", metric_name: "calcValidity", score: null, explanation: null };
  if (!expected) {
    if (actual) {
      Object.assign(validity, { score: 0.0, explanation: "The request called for no formula, but the model wrote one." });
    } else {
      Object.assign(validity, { score: 1.0, explanation: "The request called for no formula and the model wrote none." });
    }
    return [validity];
  }
  let problems = score.problems;
  if (!Array.isArray(problems)) problems = score["error-message"] ? [score["error-message"]] : [];
  if (score["obeys-tableau-expression-grammar"]) {
    Object.assign(validity, { score: 1.0, explanation: "Valid Tableau Prep formula." });
  } else {
    Object.assign(validity, {
      score: 0.0,
      explanation: (problems as unknown[]).length ? (problems as string[]) : null,
    });
  }
  return [
    validity,
    {
      metric_id: "PrepCalcSimilarity",
      metric_name: "levenshteinSimilarity",
      score: (score["levenshtein-similarity"] as number | null | undefined) ?? null,
      explanation: (score["similarity-explanation"] as string | null | undefined) ?? null,
    },
  ];
}

/** Intent Match, with what was compared in the explanation. */
export function intentMetric(rec: PrepRecord, gen: Entry, score: Entry): MetricEntry {
  const raw = gen["intent-detected"];
  const answered = typeof raw === "string" && Boolean(raw.trim());
  const expected = score["expected-intent"] || rec["expected-intent"];
  const detected = score["intent-detected"] !== null && score["intent-detected"] !== undefined ? score["intent-detected"] : raw;
  const correct = Boolean(score["determined-correct-intent"]);
  const value = isNumber(score["intent-score"]) ? (score["intent-score"] as number) : correct ? 1.0 : 0.0;
  return {
    metric_id: "PrepIntentMatch",
    metric_name: "equals",
    score: value,
    explanation: intentExplanation(answered, pyStr(expected), pyStr(detected), value),
  };
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

const isNumber = (v: unknown): v is number => typeof v === "number" && !Number.isNaN(v);

/** Convert a bench per-case context into the row payload. */
export function serializeCase(
  kind: SuiteKind,
  caseId: string,
  rec: PrepRecord,
  context: Record<string, unknown>,
): RowPayload {
  const genStage = GENERATOR_STAGE[kind];
  const gen = (isObj(context[genStage]) ? context[genStage] : {}) as Entry;
  const scoreStage = SCORER_STAGE[kind];
  const score = (scoreStage && isObj(context[scoreStage]) ? context[scoreStage] : {}) as Entry;
  const genFailed = isExceptionEntry(gen);
  const scoreFailed = isExceptionEntry(score);
  const hasGen = Object.keys(gen).length > 0;
  const rawReply = typeof gen.generation === "string" ? gen.generation : null;
  // The model answered, but the bench could not read the answer.
  const unreadable = genFailed && kind in UNREADABLE_METRIC && Boolean(rawReply && rawReply.trim());
  // The request itself failed: the bench recorded the response body and nothing else.
  const requestFailed = hasGen && !genFailed && !(OUTPUT_KEY[kind] in gen);

  const latency = isNumber(gen["latency-ms"]) ? gen["latency-ms"] / 1000.0 : null;

  let actual: Record<string, unknown> = {};
  if (unreadable) {
    actual = { raw_reply: rawReply!.slice(0, DEBUG_GENERATION_CAP) };
  } else if (!genFailed && !requestFailed) {
    if (kind === "calc-gen") {
      actual = { calculation: gen["actual-calc"] ?? null, user_friendly_reply: gen["user-friendly-explanation"] ?? null };
    } else if (kind === "flow-plan-gen") {
      actual = { flowPlan: gen["flow-plan"] ?? null };
    } else {
      actual = { intent: gen["intent-detected"] ?? null };
    }
  }

  const metrics: Record<string, MetricEntry[]> = {};
  if (!scoreFailed && Object.keys(score).length) {
    if (kind === "calc-gen") metrics.calculatedFieldFormula = calcMetrics(rec, gen, score);
    else if (kind === "intent-gen") metrics.intent = [intentMetric(rec, gen, score)];
  }
  if (kind === "flow-plan-gen" && hasGen && !genFailed && !requestFailed) {
    const expectedSteps = rec["expected-flow-plan"];
    if (isStepList(expectedSteps)) metrics.flowPlan = flowPlanMetrics(expectedSteps, planStepNames(gen["flow-plan"]), rec["acceptable-flow-plans"]);
  }

  const errors: RowError[] = [];
  if (unreadable) {
    // An answer the feature cannot read is a wrong answer, not a lost
    // request: it scores zero and the row keeps the reply.
    const [stage, metricId, metricName] = UNREADABLE_METRIC[kind]!;
    metrics[stage] = [
      {
        metric_id: metricId,
        metric_name: metricName,
        score: 0.0,
        explanation: `The model's answer could not be read: ${gen.message}`,
      },
    ];
    errors.push({
      phase: genStage,
      description: `The model answered, but not in the format the test expects, so the case scores zero. ${gen.message}`,
      warning: true,
    });
  }
  if (requestFailed) {
    const resp = gen.response;
    const detail = isObj(resp) ? resp.message : null;
    errors.push({
      phase: genStage,
      description:
        "The request to the model failed" + (detail ? `: ${String(detail).slice(0, 500)}` : " and returned no answer."),
      warning: false,
    });
  }
  for (const [stageName, entry] of Object.entries(context)) {
    if (stageName === genStage && unreadable) continue;
    if (isExceptionEntry(entry)) {
      errors.push({ phase: stageName, description: `${entry.message} (${pyStr(entry.location)})`, warning: false });
    }
  }

  const debugInfo: Record<string, unknown> = {};
  if (hasGen && (!genFailed || "prompt" in gen)) {
    debugInfo.prompt = gen.prompt ?? null;
    debugInfo.model_parameters = gen["model-parameters"] ?? null;
    if (typeof gen.generation === "string") debugInfo.generation = gen.generation.slice(0, DEBUG_GENERATION_CAP);
    const resp = gen.response;
    if (isObj(resp)) {
      const usage = isObj(resp.parameters) ? resp.parameters.usage : null;
      if (usage) debugInfo.usage = usage;
    }
    // The model put other text around its JSON answer and the tool scored the
    // object it found: a fact about the reply, not a warning on the row.
    if (gen["json-extracted"]) debugInfo.json_extracted_from_reply = true;
  }

  return {
    test_case_id: caseId,
    runner: `prep-${kind}`,
    datasource: dataName(rec),
    utterance: rec.canonical || "",
    turn: 0,
    expected: expectedDict(kind, rec),
    actual,
    latency,
    errors,
    metrics,
    debug_info: debugInfo,
    info: { description: rec.description ?? null },
  };
}
