/**
 * Prep adapter serialization regression tests.
 * Serialization of the bench context, the step-by-step flow-plan
 * scores, JSON extraction, the decline rule and the intent explanations.
 */
import { describe, expect, test } from "bun:test";
import type { PrepRecord } from "./bench.ts";
import { dataName } from "./bench.ts";
import {
  extractJsonObject,
  flowPlanMetrics,
  isExceptionEntry,
  recoverWrappedJson,
  serializeCase,
} from "./serialize.ts";

const CALC_REC: PrepRecord = {
  "test-file": "sum-tests.yaml",
  id: "sum-1",
  canonical: "total sales",
  description: "basic sum",
  "is-followup": false,
  "expected-calc": "SUM([Sales])",
  "flow-name": "Superstore.tflx",
  "field-metadata": "…",
};

const FLOW_REC: PrepRecord = {
  "test-file": "f.yaml",
  id: "p-1",
  canonical: "last 90 days",
  "expected-flow-plan": ["FilterValuesByRelativeDateFilter"],
  "data-location": "test/test-data/x.txt",
  "is-followup": false,
  description: null,
};

const byName = <T extends { metric_name: string }>(xs: T[]): Record<string, T> =>
  Object.fromEntries(xs.map((m) => [m.metric_name, m]));

describe("serializeCase", () => {
  test("calc case maps metrics and latency", () => {
    const row = serializeCase("calc-gen", "sum-tests__sum-1", CALC_REC, {
      calc_generator: {
        prompt: "p.mustache",
        "model-parameters": { model: "gpt-4o", max_tokens: 4090 },
        "latency-ms": 2500,
        generation: "x".repeat(10000),
        response: { parameters: { usage: { total_tokens: 42 } } },
        "actual-calc": "SUM([Sales])",
        "user-friendly-explanation": "Sums sales.",
      },
      calc_scorer: { "obeys-tableau-expression-grammar": true, "levenshtein-similarity": 0.93, "error-message": "" },
    });
    expect(row.latency).toBe(2.5);
    expect(row.actual).toEqual({ calculation: "SUM([Sales])", user_friendly_reply: "Sums sales." });
    const m = byName(row.metrics.calculatedFieldFormula!);
    expect(m.calcValidity.score).toBe(1.0);
    expect(m.levenshteinSimilarity.score).toBe(0.93);
    expect((row.debug_info.generation as string).length).toBe(4000);
    expect(row.debug_info.usage).toEqual({ total_tokens: 42 });
    expect(row.errors).toEqual([]);
  });

  test("calc case explains validity and similarity", () => {
    const context: Record<string, unknown> = {
      calc_generator: { "actual-calc": "IF [Profit] > 0 THEN 'a' ELSE 'b'", "latency-ms": 100 },
      calc_scorer: {
        "obeys-tableau-expression-grammar": false,
        problems: ["IF without END", "Field not in the data: [Profit]"],
        "error-message": "IF without END; Field not in the data: [Profit]",
        "levenshtein-similarity": 0.6,
        "similarity-explanation": "3 of the 5 expected tokens appear in order in the written formula (5 tokens). First difference: 'END' is missing.",
      },
    };
    let m = byName(serializeCase("calc-gen", "x", CALC_REC, context).metrics.calculatedFieldFormula!);
    expect(m.calcValidity.score).toBe(0.0);
    expect<unknown>(m.calcValidity.explanation).toEqual(["IF without END", "Field not in the data: [Profit]"]);
    const explanation = m.levenshteinSimilarity.explanation;
    if (typeof explanation !== "string") throw new Error("Expected a similarity explanation string");
    expect(explanation).toStartWith("3 of the 5 expected tokens");
    context.calc_scorer = { "obeys-tableau-expression-grammar": true, "error-message": "", "levenshtein-similarity": 1.0 };
    m = byName(serializeCase("calc-gen", "x", CALC_REC, context).metrics.calculatedFieldFormula!);
    expect(m.calcValidity).toEqual({
      metric_id: "PrepCalcGrammar",
      metric_name: "calcValidity",
      score: 1.0,
      explanation: "Valid Tableau Prep formula.",
    });
    expect(m.levenshteinSimilarity.explanation).toBeNull();
  });

  test("a case that expects no formula scores the decline", () => {
    const rec = { ...CALC_REC, "expected-calc": "" };
    const [declined] = serializeCase("calc-gen", "u-1", rec, {
      calc_generator: { "actual-calc": "", "user-friendly-explanation": "I cannot help with that." },
      calc_scorer: { "obeys-tableau-expression-grammar": false, problems: ["Empty formula"], "levenshtein-similarity": 1.0 },
    }).metrics.calculatedFieldFormula!;
    expect([declined!.score, declined!.explanation]).toEqual([1.0, "The request called for no formula and the model wrote none."]);
    const wrote = serializeCase("calc-gen", "u-1", rec, {
      calc_generator: { "actual-calc": "SUM([Sales])" },
      calc_scorer: { "obeys-tableau-expression-grammar": true, problems: [], "levenshtein-similarity": 0.0 },
    }).metrics.calculatedFieldFormula!;
    expect(wrote.map((x) => [x.score, x.explanation])).toEqual([[0.0, "The request called for no formula, but the model wrote one."]]);
  });

  test("an exception stage becomes an error row", () => {
    const row = serializeCase("calc-gen", "id", CALC_REC, {
      calc_generator: { message: "Exception ValueError: LLM said no", location: "generator_plugin.py:80" },
    });
    expect([row.metrics, row.actual, row.latency]).toEqual([{}, {}, null]);
    expect(row.errors).toEqual([
      { phase: "calc_generator", description: "Exception ValueError: LLM said no (generator_plugin.py:80)", warning: false },
    ]);
  });

  test("a failed request is an error, not a silent blank", () => {
    const rec: PrepRecord = { canonical: "make a calc", "expected-intent": "calc" };
    const row = serializeCase("intent-gen", "f__i-1", rec, {
      intent_generator: {
        prompt: "p.mustache",
        "model-parameters": { model: "m" },
        "latency-ms": 35000,
        generation: null,
        response: { message: "CES generations failed: HTTP 500: boom" },
      },
    });
    expect([row.actual, row.metrics]).toEqual([{}, {}]);
    expect(row.errors.length).toBe(1);
    expect(row.errors[0]!.warning).toBe(false);
    expect(row.errors[0]!.description).toContain("HTTP 500: boom");
    expect(row.latency).toBe(35.0);
  });

  test("a generator exception with context is recognized", () => {
    const row = serializeCase("flow-plan-gen", "f__p-1", FLOW_REC, {
      flow_plan_generator: {
        message: "Exception ConnectionError: refused",
        location: "generator_plugin.py:55",
        prompt: "p.mustache",
        "model-parameters": { model: "m" },
        "latency-ms": null,
        generation: null,
        response: null,
      },
    });
    expect([row.actual, row.metrics]).toEqual([{}, {}]);
    expect(row.errors.map((e) => e.warning)).toEqual([false]);
    expect(row.errors[0]!.description).toContain("refused");
  });

  test("an unreadable answer scores zero and keeps the reply", () => {
    const row = serializeCase("flow-plan-gen", "f__p-1", FLOW_REC, {
      flow_plan_generator: {
        message: "Exception JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
        location: "generator_plugin.py:90",
        prompt: "p.mustache",
        "model-parameters": { model: "m" },
        "latency-ms": 800,
        generation: "I cannot do that.",
        response: {},
      },
    });
    expect(row.actual).toEqual({ raw_reply: "I cannot do that." });
    const [m] = row.metrics.flowPlan!;
    expect([m!.metric_name, m!.score]).toEqual(["planSimilarity", 0.0]);
    expect(m!.explanation).toContain("could not be read");
    expect(row.errors.map((e) => e.warning)).toEqual([true]);
    expect(row.debug_info.generation).toBe("I cannot do that.");
  });

  test("a plan without steps scores zero, not an error", () => {
    const row = serializeCase("flow-plan-gen", "f__p-1", FLOW_REC, {
      flow_plan_generator: {
        prompt: "p",
        "latency-ms": 500,
        generation: null,
        response: {},
        "flow-plan": { userFriendlyExplanation: "Which names would you like?" },
      },
    });
    expect(row.errors).toEqual([]);
    expect(row.metrics.flowPlan!.map((m) => m.score)).toEqual([0.0, 0.0, 0.0]);
  });

  test("intent case lands on intent equals, and explains a miss and a blank", () => {
    const rec: PrepRecord = { canonical: "make a calc", "expected-intent": "calc" };
    const row = serializeCase("intent-gen", "f__i-1", rec, {
      intent_generator: { "intent-detected": "calc", "latency-ms": 100 },
      intent_scorer: { "determined-correct-intent": true },
    });
    expect(row.metrics.intent).toEqual([
      { metric_id: "PrepIntentMatch", metric_name: "equals", score: 1.0, explanation: "Matches: calc." },
    ]);
    expect([row.expected, row.actual]).toEqual([{ intent: "calc" }, { intent: "calc" }]);
    const flow: PrepRecord = { canonical: "join my inputs", "expected-intent": "flow-plan" };
    const [miss] = serializeCase("intent-gen", "x", flow, {
      intent_generator: { "intent-detected": "`Calc`" },
      intent_scorer: { "determined-correct-intent": false, "intent-detected": "calc", "expected-intent": "flow-plan" },
    }).metrics.intent!;
    expect([miss!.score, miss!.explanation]).toEqual([0.0, "Expected flow-plan, the model said calc."]);
    const [blank] = serializeCase("intent-gen", "x", flow, {
      intent_generator: { "intent-detected": "  " },
      intent_scorer: { "determined-correct-intent": false, "intent-detected": "", "expected-intent": "flow-plan" },
    }).metrics.intent!;
    expect([blank!.score, blank!.explanation]).toEqual([0.0, "The model answered nothing."]);
  });
});

test("JSON is extracted from a wrapped reply", () => {
  expect(extractJsonObject('Reasoning with {braces}.\n```json\n{"functions": []}\n```')).toBe('{"functions": []}');
  expect(extractJsonObject('Here you go: {"calc": "SUM([Sales])"} Hope it helps')).toBe('{"calc": "SUM([Sales])"}');
  expect(extractJsonObject('```json\n{"a": 1}\n```\nbetter:\n```\n{"a": 2}\n```')).toBe('{"a": 2}');
  expect(extractJsonObject("no json here")).toBeNull();
  expect(extractJsonObject("[1, 2, 3]")).toBeNull();
});

test("a wrapped JSON answer is read and scored, and recorded with the reply", () => {
  const reply =
    '## Analysis\nuse a relative date filter\n```json\n{"functions": [{"functionName": "FilterValuesByRelativeDateFilter"}]}\n```';
  const context: Record<string, unknown> = {
    flow_plan_generator: { message: "Exception JSONDecodeError: x", location: "x.py:1", prompt: "p", "latency-ms": 900, generation: reply, response: {} },
  };
  expect(recoverWrappedJson("flow_plan_generator", (g) => ({ "flow-plan": JSON.parse(g) }), context)).toBe(true);
  const row = serializeCase("flow-plan-gen", "f__p-1", FLOW_REC, context);
  expect(Object.fromEntries(row.metrics.flowPlan!.map((m) => [m.metric_name, m.score]))).toEqual({
    planSimilarity: 1.0,
    stepRecall: 1.0,
    stepPrecision: 1.0,
  });
  expect(row.errors).toEqual([]);
  expect(row.debug_info.json_extracted_from_reply).toBe(true);
  expect(row.datasource).toBe("x.txt");
  // A reply with no JSON at all stays failed.
  const failed: Record<string, unknown> = {
    flow_plan_generator: { message: "Exception X: y", location: "x.py:1", generation: "no plan, sorry" },
  };
  expect(recoverWrappedJson("flow_plan_generator", (g) => JSON.parse(g), failed)).toBe(false);
  expect(isExceptionEntry(failed.flow_plan_generator)).toBe(true);
});

test("a flow plan is scored step by step, not letter by letter", () => {
  const s = (e: string[], a: string[]) => byName(flowPlanMetrics(e, a));
  const wrong = s(["CreateAggregateStep"], ["CreateCleanStep"]);
  expect([wrong.planSimilarity.score, wrong.stepRecall.score, wrong.stepPrecision.score]).toEqual([0, 0, 0]);
  expect(wrong.stepRecall.explanation).toContain("Missing: CreateAggregateStep");
  const same = s(["A", "B", "C"], ["A", "B", "C"]);
  expect([same.planSimilarity.score, same.stepRecall.score, same.stepPrecision.score]).toEqual([1, 1, 1]);
  const extra = s(["Filter", "Aggregate"], ["FixTypes", "Filter", "Aggregate"]);
  expect(extra.stepRecall.score).toBe(1.0);
  expect(extra.stepPrecision.score).toBeCloseTo(2 / 3, 12);
  expect(extra.planSimilarity.score).toBeCloseTo(0.8, 12);
  expect(extra.stepPrecision.explanation).toContain("Not expected: FixTypes");
  const swapped = s(["A", "B"], ["B", "A"]);
  expect([swapped.stepRecall.score, swapped.stepPrecision.score, swapped.planSimilarity.score]).toEqual([1, 1, 0.5]);
  expect(s(["Aggregate", "Filter", "Aggregate"], ["Aggregate", "Filter"]).stepRecall.score).toBeCloseTo(2 / 3, 12);
  const none = s(["Rename"], []);
  expect([none.planSimilarity.score, none.stepRecall.score, none.stepPrecision.score]).toEqual([0, 0, 0]);
  expect(none.stepPrecision.explanation).toBe("The plan has no steps.");
});

test("the datasource names the flow or the step-data file", () => {
  expect(dataName({ canonical: "", "flow-name": "SuperstoreOneOutput.tflx" })).toBe("SuperstoreOneOutput.tflx");
  expect(dataName({ canonical: "", "flow-name": "SKIP" })).toBeNull();
  expect(dataName({ canonical: "", "data-location": "test/test-data/flow-plan-gen/step-data/website-traffic.txt" })).toBe(
    "website-traffic.txt",
  );
  expect(dataName({ canonical: "" })).toBeNull();
});
