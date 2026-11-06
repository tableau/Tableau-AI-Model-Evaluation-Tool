/**
 * Scoring a stored run again with the current chart metrics.
 * Covers deterministic stored-answer replay.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { join } from "node:path";
import { flattenPrepSuite, NO_EXPECTED_CHART_WARNING, prepCasesBase } from "@tableau-ai-eval/evals";
import { buildRunBundleFromData } from "./publish/records.ts";
import {
  chartRunIds,
  rescorableRunIds,
  rescoreCommand,
  rescoreRun,
  rescoreVizQuality,
  rescoreDashboardQa,
  rescoreNarrativeJudge,
} from "./rescore.ts";

let db: AiEvalDb;
beforeEach(() => {
  db = new AiEvalDb(":memory:");
  db.initDb();
});
afterEach(() => db.close());

test("Dashboard Q&A rescore drops obsolete metrics without a configured judge", async () => {
  const job = seed();
  db.insertTestMetrics(job, "swap", "dashboardQA", [{ metric_name: "outputTypeMatch", score: 0 }]);
  db.insertTestMetrics(job, "swap", "llmJudge", [
    { metric_name: "coherence", score: 0.2 },
    { metric_name: "answerCorrectness", score: 0.8 },
  ]);
  const counts = await rescoreDashboardQa(db, job, null);
  expect(counts.dropped).toBe(2);
  expect(
    db
      .getMetrics(job)
      .filter((m) => m.stage === "llmJudge")
      .map((m) => m.metric_name),
  ).toEqual(["answerCorrectness"]);
});

test("narrative rescore preserves unrelated metrics and replaces selected scores", async () => {
  const job = seed();
  result(job, "narrative", "Summary", {}, { insightNarrative: "Sales grew." }, 1);
  db.insertTestMetrics(job, "narrative", "llmJudge", [
    { metric_name: "Semantic Factuality Precision Rate", score: 0 },
    { metric_name: "llmIsSimilar", score: 0.5 },
  ]);
  // No captured truths: the reference perfect-factuality shortcut
  // makes this an offline test, with no provider request.
  const counts = await rescoreNarrativeJudge(db, job, { provider: "openai", api_key: "test" }, [
    "Semantic Factuality Precision Rate",
  ]);
  expect(counts.judged).toBe(1);
  const scores = db.getMetrics(job).filter((m) => m.test_case_id === "narrative");
  expect(scores.find((m) => m.metric_name === "Semantic Factuality Precision Rate")?.score).toBe(1);
  expect(scores.find((m) => m.metric_name === "llmIsSimilar")?.score).toBe(0.5);
});

const field = (
  caption: string,
  encoding: string,
  role = "dimension",
  data = "string",
  aggregation?: string,
) => ({
  caption,
  role,
  data,
  encoding,
  ...(aggregation ? { aggregation } : {}),
});

function result(
  job: string,
  id: string,
  utterance: string,
  expected: unknown,
  actual: unknown,
  latency: number | null,
) {
  db.insertTestResult({
    job_id: job,
    test_case_id: id,
    runner: "ect-server",
    datasource: "ds",
    utterance,
    expected,
    actual,
    latency,
    debug_info: null,
    info: null,
  });
}

function seed(job = "re5c0000000000000000000000000001"): string {
  db.createRun({
    job_id: job,
    org_id: "",
    user_id: "",
    ai_feature: "viz-authoring",
    runner_name: "ect-server",
    config: { suite_id: "viz-authoring-public" },
  });
  const expected = {
    intent: "NLQ_TO_NOTIONAL_SPEC",
    notionalSpec: {
      chart: "bar",
      fields: [field("Region", "x"), field("Sales", "y", "measure", "number", "sum")],
    },
  };
  const swapped = {
    intent: "NLQ_TO_NOTIONAL_SPEC",
    notionalSpec: {
      chart: "bar",
      fields: [field("Region", "y"), field("Sales", "x", "measure", "number", "sum")],
    },
    user_friendly_reply: "A bar chart of the sum of Sales by Region.",
  };
  result(job, "swap", "sales by region", expected, swapped, 1.0);
  // Scored by an older version of the metrics: stale rows to replace.
  db.insertTestMetrics(job, "swap", "vizQuality", [
    { metric_name: "fieldSimilarity", score: 0.0, explanation: "old" },
    { metric_name: "axisAccuracy", score: 0.0, explanation: "old" },
  ]);
  db.insertTestMetrics(job, "swap", "intent", [{ metric_name: "equals", score: 1.0 }]);
  // A case the suite ships without an expected chart, scored anyway back then.
  result(
    job,
    "none",
    "do not show nulls",
    { intent: "NLQ_TO_NOTIONAL_SPEC", notionalSpec: null },
    swapped,
    1.0,
  );
  db.insertTestMetrics(job, "none", "vizQuality", [{ metric_name: "sortAccuracy", score: 1.0 }]);
  // A calculation case: no chart to score, left alone.
  result(
    job,
    "calc",
    "profit ratio",
    { intent: "NLQ_TO_NEW_CALCULATED_FIELD", calculatedFieldFormula: { formula: "1" } },
    { calculatedFieldFormula: { formula: "1" } },
    1.0,
  );
  db.insertTestMetrics(job, "calc", "calculatedFieldFormula", [
    { metric_name: "calcValidity", score: 1.0 },
  ]);
  // A case the server never answered: no metrics, then or now.
  result(job, "err", "sales by region", expected, {}, null);
  db.insertTestErrors(job, "err", [{ phase: "runTest", description: "HTTP 500", warning: false }]);
  db.updateRunStatus(job, "finished", { total: 4, completed: 4 });
  return job;
}

test("rescoring replaces the chart metrics and warns on missing expected charts", () => {
  const job = seed();
  db.runScores([job]); // the home page caches the old scores
  expect("score_version" in db.getJobState(job)).toBe(true);

  expect(rescoreVizQuality(db, job)).toEqual({
    cases: 4,
    scored: 1,
    no_expected_chart: 1,
    not_a_chart_case: 1,
    unanswered: 1,
    unchanged: 0,
  });

  const byCase: Record<
    string,
    Record<string, Record<string, { score: number | null; explanation?: string | null }>>
  > = {};
  for (const m of db.getMetrics(job)) {
    byCase[m.test_case_id] ??= {};
    const stages = byCase[m.test_case_id];
    stages[m.stage] ??= {};
    const metrics = stages[m.stage];
    metrics[m.metric_name] = m;
  }
  const swap = byCase.swap!.vizQuality!;
  expect(swap.fieldSimilarity!.score).toBe(1.0);
  expect(swap.fieldSimilarity!.explanation).toContain("swapped");
  expect(swap.axisAccuracy!.score).toBe(1.0);
  expect(swap.informationSimilarity!.score as number).toBeGreaterThan(0.5);
  expect(Object.values(swap).map((m) => m.explanation)).not.toContain("old");
  expect(byCase.swap!.intent!.equals!.score).toBe(1.0); // untouched
  expect(byCase.none?.vizQuality).toBeUndefined(); // no longer scored
  expect(byCase.err).toBeUndefined(); // never answered: still no scores
  expect(byCase.calc!.calculatedFieldFormula!.calcValidity!.score).toBe(1.0);

  const warnings = db.getErrors(job).filter((e) => e.test_case_id === "none");
  expect(warnings.map((e) => e.description)).toEqual([NO_EXPECTED_CHART_WARNING]);
  expect(Number(warnings[0]!.is_warning)).toBe(1);
  // Running it again adds no second warning and the same metrics.
  rescoreVizQuality(db, job);
  expect(db.getErrors(job).filter((e) => e.test_case_id === "none").length).toBe(1);

  // The cached home-page scores were dropped and come back from the new rows.
  expect("score_version" in db.getJobState(job)).toBe(false);
  const headline = db.runScores([job])[job]!.headline_scores!;
  expect(headline.find((h) => h.key === "viz")!.average).toBe(1.0);

  // In the export, a case without an expected chart is unscored and has no
  // verdict (Intent Match alone used to make it a pass).
  const bundle = buildRunBundleFromData(job, db.getFullResults(job)!, db.getJobState(job));
  const byId = Object.fromEntries(bundle.cases.map((c) => [c.test_case_id, c]));
  expect([byId.none!.case_status, byId.none!.case_score, byId.none!.case_verdict]).toEqual([
    "unscored",
    null,
    "na",
  ]);
  expect(byId.none!.warning_count).toBe(1);
  expect([byId.swap!.case_status, byId.swap!.case_verdict]).toEqual(["scored", "pass"]);
  expect([byId.err!.case_status, byId.err!.case_verdict]).toEqual(["error", "na"]);
});

test("chart runs are found by their expected charts", () => {
  const job = seed();
  expect(chartRunIds(db)).toEqual([job]);
});

test("the command takes run-id prefixes and refuses an ambiguous or unknown one", () => {
  const job = seed();
  const out: string[] = [];
  const write = (s: string) => out.push(s);
  expect(rescoreCommand(db, ["re5c"], write)).toBe(0);
  expect(out[0]).toBe(
    `${job}: 1 chart cases scored again, 1 without an expected chart left unscored, 1 other cases untouched\n`,
  );
  out.length = 0;
  expect(rescoreCommand(db, ["nope"], write)).toBe(2);
  expect(out[0]).toBe("nope: no runs that can be scored again match\n");
  out.length = 0;
  expect(rescoreCommand(db, [], write)).toBe(2);
  expect(out[0]).toBe("Nothing to score: name a run id or pass --all.\n");
});

// ---------------------------------------------------------------------------
// Prep runs: scored again by the bench that ships with the tool.
// ---------------------------------------------------------------------------

function prepCases(kind: "calc-gen" | "intent-gen", n = 1) {
  const out = flattenPrepSuite(join(prepCasesBase()!, kind), kind).filter(
    (c) => kind !== "calc-gen" || c.record["expected-calc"],
  );
  expect(out.length).toBeGreaterThanOrEqual(n);
  return out.slice(0, n);
}

function prepResult(job: string, id: string, runner: string, expected: unknown, actual: unknown) {
  db.insertTestResult({
    job_id: job,
    test_case_id: id,
    runner,
    datasource: null,
    utterance: "x",
    expected,
    actual,
    latency: 1.0,
    debug_info: null,
    info: null,
  });
}

test("Prep calculation runs are scored again from the stored formula", () => {
  const job = "re5c0000000000000000000000000002";
  const [c, gone, unread] = prepCases("calc-gen", 3);
  db.createRun({
    job_id: job,
    org_id: "",
    user_id: "",
    ai_feature: "prep-calc",
    runner_name: "prep-calc-gen",
    config: {},
  });
  const expected = String(c!.record["expected-calc"]);
  const written = `  ${expected.replaceAll(" ", "  ")}  // same thing`;
  prepResult(job, c!.caseId, "prep-calc-gen", { calculation: expected }, { calculation: written });
  db.insertTestMetrics(job, c!.caseId, "calculatedFieldFormula", [
    { metric_name: "calcValidity", score: 1.0, explanation: null },
    { metric_name: "levenshteinSimilarity", score: 0.7, explanation: null },
  ]);
  prepResult(job, gone!.caseId, "prep-calc-gen", { calculation: "1" }, {});
  prepResult(job, unread!.caseId, "prep-calc-gen", { calculation: "1" }, { raw_reply: "no" });
  prepResult(
    job,
    "sum-tests__retired",
    "prep-calc-gen",
    { calculation: "1" },
    { calculation: "1" },
  );
  db.updateRunStatus(job, "finished", { total: 4, completed: 4 });

  expect(rescoreRun(db, job)).toEqual({
    kind: "prep",
    cases: 4,
    scored: 1,
    unanswered: 2,
    unknown_case: 1,
  });
  const byName = Object.fromEntries(
    db
      .getMetrics(job)
      .filter((m) => m.test_case_id === c!.caseId)
      .map((m) => [m.metric_name, m]),
  );
  expect(Object.keys(byName).sort()).toEqual(["calcValidity", "levenshteinSimilarity"]);
  expect(byName.levenshteinSimilarity!.score).toBe(1.0);
  expect(byName.levenshteinSimilarity!.explanation).toContain("same formula");
  expect([byName.calcValidity!.score, byName.calcValidity!.explanation]).toEqual([
    1.0,
    "Valid Tableau Prep formula.",
  ]);
  expect(rescorableRunIds(db)).toEqual([job]);
});

test("Prep intent runs are scored again from the stored answer", () => {
  const job = "re5c0000000000000000000000000003";
  const [c] = prepCases("intent-gen");
  const intent = String(c!.record["expected-intent"]);
  db.createRun({
    job_id: job,
    org_id: "",
    user_id: "",
    ai_feature: "prep-intent",
    runner_name: "prep-intent-gen",
    config: {},
  });
  prepResult(
    job,
    c!.caseId,
    "prep-intent-gen",
    { intent },
    { intent: `\`${intent.toUpperCase()}\`.` },
  );
  db.insertTestMetrics(job, c!.caseId, "intent", [
    { metric_name: "equals", score: 0.0, explanation: null },
  ]);
  db.updateRunStatus(job, "finished", { total: 1, completed: 1 });
  const counts = rescoreRun(db, job);
  expect([counts.kind, counts.scored]).toEqual(["prep", 1]);
  const [metric] = db.getMetrics(job);
  expect([metric!.score, metric!.explanation]).toEqual([1.0, `Matches: ${intent}.`]);
});

test("a follow-up answered without a chart is scored on the chart that stood", () => {
  // Stored runs made before the rule, or by the evaluator path, get it on
  // rescore: the last chart of the conversation is compared, the stored
  // answer records it, and a first turn with no chart stays unscored.
  const job = "re5c0000000000000000000000000002";
  db.createRun({
    job_id: job,
    org_id: "",
    user_id: "",
    ai_feature: "viz-authoring",
    runner_name: "ect-server",
    config: { suite_id: "viz-authoring-public" },
  });
  const chart = {
    chart: "bar",
    fields: [field("Region", "x"), field("Sales", "y", "measure", "number", "sum")],
    categoricalFilters: [{ type: "categorical", field: "Region", values: ["West"] }],
  };
  const expected = { intent: "NLQ_TO_NOTIONAL_SPEC", notionalSpec: chart };
  result(job, "conv:0", "sales by region, West only", expected, { intent: "NLQ_TO_NOTIONAL_SPEC", notionalSpec: chart }, 1.0);
  result(job, "conv:1", "include West", expected, { intent: "NLQ_TO_NOTIONAL_SPEC", user_friendly_reply: "West is already shown." }, 1.0);
  db.insertTestMetrics(job, "conv:1", "vizQuality", [{ metric_name: "fieldSimilarity", score: 0.0, explanation: "old" }]);
  result(job, "alone", "sales by region", expected, { intent: "NLQ_TO_NOTIONAL_SPEC", user_friendly_reply: "I cannot." }, 1.0);
  db.updateRunStatus(job, "finished", { total: 3, completed: 3 });

  const counts = rescoreVizQuality(db, job);
  expect(counts.scored).toBe(3);
  expect(counts.unchanged).toBe(1);

  const byCase: Record<string, Record<string, { score: number | null; explanation?: string | null }>> = {};
  for (const m of db.getMetrics(job)) {
    if (m.stage !== "vizQuality") continue;
    byCase[m.test_case_id] ??= {};
    byCase[m.test_case_id]![m.metric_name] = m;
  }
  expect(byCase["conv:1"]!.fieldSimilarity!.score).toBe(1.0);
  expect(byCase["conv:1"]!.filterAccuracy!.score).toBe(1.0);
  expect(byCase["conv:1"]!.fieldSimilarity!.explanation!.startsWith("The model left the chart as it was")).toBe(true);
  expect(byCase.alone!.fieldSimilarity!.score).toBe(0.0);
  const stored = Object.fromEntries(db.getResults(job).map((r) => [r.test_case_id, r.actual as Record<string, unknown>]));
  expect(stored["conv:1"]!.unchanged_chart).toEqual(chart);
  expect("notionalSpec" in stored["conv:1"]!).toBe(false);
  expect(stored.alone!.unchanged_chart).toBeUndefined();
});
