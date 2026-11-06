import { test, expect, beforeEach, afterEach } from "bun:test";
import { AiEvalDb, explanationText, scalarScore } from "./index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mc from "../metrics/catalog.ts";

let db: AiEvalDb;

beforeEach(() => {
  // In-memory DB is fine for round-trip assertions; WAL pragma is a no-op
  // on :memory: but the exec call is exercised.
  db = new AiEvalDb(":memory:");
  db.initDb();
});

afterEach(() => {
  db.close();
});

test("schema creates legacy tables and additive observation tables", () => {
  const rows = db.db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all();
  const names = rows.map((r) => r.name).filter((n) => !n.startsWith("sqlite_"));
  expect(names.sort()).toEqual(
    [
      "events",
      "job_state",
      "run_changes",
      "run_observations",
      "runs",
      "settings",
      "test_errors",
      "test_metrics",
      "test_results",
    ].sort(),
  );
});

test("schema creates legacy indexes and the observation revision index", () => {
  const rows = db.db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
    )
    .all();
  expect(rows.map((r) => r.name)).toEqual([
    "idx_events_job",
    "idx_run_changes_job",
    "idx_test_errors_job",
    "idx_test_metrics_job",
    "idx_test_results_job",
  ]);
});

test("runs round-trip (create -> read, config JSON parsed)", () => {
  db.createRun({
    job_id: "job-1",
    org_id: "org-9",
    user_id: "user-3",
    ai_feature: "nlq",
    runner_name: "runner-a",
    config: { suite_id: "s1", nested: { k: 1 } },
  });
  const run = db.getRun("job-1");
  expect(run).not.toBeNull();
  expect(run!.job_id).toBe("job-1");
  expect(run!.org_id).toBe("org-9");
  expect(run!.status).toBe("queued");
  expect(run!.config).toEqual({ suite_id: "s1", nested: { k: 1 } });

  db.updateRunStatus("job-1", "finished", { total: 5, completed: 5 });
  const done = db.getRun("job-1");
  expect(done!.status).toBe("finished");
  expect(done!.total).toBe(5);
  expect(done!.completed).toBe(5);
  expect(done!.finished_at).toBeTruthy();
});

test("test_results round-trip (JSON fields parsed, NULL latency)", () => {
  db.createRun({
    job_id: "job-2",
    org_id: "o",
    user_id: "u",
    ai_feature: "nlq",
    runner_name: "r",
    config: {},
  });
  db.insertTestResult({
    job_id: "job-2",
    test_case_id: "tc-1",
    runner: "r",
    datasource: "superstore",
    utterance: "sales by region",
    expected: { calc: "SUM([Sales])" },
    actual: { calc: "SUM([Sales])" },
    latency: 1.25,
    debug_info: { steps: 3 },
    info: null,
  });
  db.insertTestResult({
    job_id: "job-2",
    test_case_id: "tc-2",
    runner: "r",
    datasource: "superstore",
    utterance: "profit",
    expected: null,
    actual: null,
    latency: null,
  });
  const results = db.getResults("job-2");
  expect(results.length).toBe(2);
  expect(results[0].test_case_id).toBe("tc-1");
  expect(results[0].expected).toEqual({ calc: "SUM([Sales])" });
  expect(results[0].debug_info).toEqual({ steps: 3 });
  expect(results[0].latency).toBeCloseTo(1.25, 6);
  expect(results[1].latency).toBeNull();
  expect(results[1].expected).toBeNull();
});

test("test_metrics round-trip (id/name aliasing, NULL score)", () => {
  db.createRun({
    job_id: "job-3",
    org_id: "o",
    user_id: "u",
    ai_feature: "nlq",
    runner_name: "r",
    config: {},
  });
  db.insertTestMetrics("job-3", "tc-1", "understand", [
    { metric_id: "m1", metric_name: "Equals", score: 1.0, explanation: "exact" },
    // exercise the id/name alias fields + NULL score (Unavailable judge)
    { id: "m2", name: "JudgeScore", score: null, explanation: "unavailable" },
  ]);
  const metrics = db.getMetrics("job-3");
  expect(metrics.length).toBe(2);
  expect(metrics[0].metric_id).toBe("m1");
  expect(metrics[0].metric_name).toBe("Equals");
  expect(metrics[0].score).toBeCloseTo(1.0, 6);
  expect(metrics[0].stage).toBe("understand");
  expect(metrics[1].metric_id).toBe("m2");
  expect(metrics[1].metric_name).toBe("JudgeScore");
  expect(metrics[1].score).toBeNull();
});

test("insert_test_metrics: list/dict explanation is flattened, non-numeric score → null", () => {
  db.createRun({
    job_id: "job-flat",
    org_id: "o",
    user_id: "u",
    ai_feature: "nlq",
    runner_name: "r",
    config: {},
  });
  // A calcValidity-style metric whose explanation is a list of findings, and a
  // dict explanation, and a non-numeric score — none of which SQLite can bind
  // directly. Before the flatten, one such metric lost the whole case's metrics.
  db.insertTestMetrics("job-flat", "tc-1", "calculatedFieldFormula", [
    {
      metric_id: "cv",
      metric_name: "calcValidity",
      score: 0,
      explanation: ["missing ]", "unknown field [Foo]"],
    },
    {
      metric_id: "d",
      metric_name: "Detail",
      score: "n/a",
      explanation: { note: "structured" },
    },
  ]);
  const metrics = db.getMetrics("job-flat");
  expect(metrics.length).toBe(2);
  expect(metrics[0].explanation).toBe("missing ]; unknown field [Foo]");
  expect(metrics[0].score).toBe(0);
  expect(metrics[1].explanation).toBe('{"note":"structured"}');
  expect(metrics[1].score).toBeNull();
});

test("explanationText / scalarScore flatteners", () => {
  expect(explanationText(null)).toBeNull();
  expect(explanationText("hi")).toBe("hi");
  expect(explanationText(["a", "", null, "b"])).toBe("a; b");
  expect(explanationText([])).toBeNull();
  expect(explanationText({ k: 1 })).toBe('{"k":1}');
  expect(explanationText(42)).toBe("42");

  expect(scalarScore(null)).toBeNull();
  expect(scalarScore(0)).toBe(0);
  expect(scalarScore(1.5)).toBe(1.5);
  expect(scalarScore(true)).toBe(1);
  expect(scalarScore(false)).toBe(0);
  expect(scalarScore("3.2")).toBeCloseTo(3.2, 6);
  expect(scalarScore("nope")).toBeNull();
});

test("updateRunConfig merges identity and redacts credentials", () => {
  db.createRun({ job_id: "identity", org_id: "", user_id: "", ai_feature: "calc", runner_name: "ect-server", config: { suite_id: "calcs-public" } });
  db.updateRunConfig("identity", { resolved_site_model: "model", tableau_pat_value: "private-token" });
  const config = db.getRun("identity")!.config!;
  expect(config.suite_id).toBe("calcs-public");
  expect(config.resolved_site_model).toBe("model");
  expect(config.tableau_pat_value).not.toBe("private-token");
  expect(() => db.updateRunConfig("missing", { resolved_site_model: "model" })).not.toThrow();
});

test("test_errors round-trip (warning flag mapped to 0/1)", () => {
  db.createRun({
    job_id: "job-4",
    org_id: "o",
    user_id: "u",
    ai_feature: "nlq",
    runner_name: "r",
    config: {},
  });
  db.insertTestErrors("job-4", "tc-1", [
    { phase: "understand", description: "timeout", warning: false },
    { phase: "create", description: "soft warn", warning: true },
  ]);
  const errors = db.getErrors("job-4");
  expect(errors.length).toBe(2);
  expect(errors[0].phase).toBe("understand");
  expect(errors[0].is_warning).toBe(0);
  expect(errors[1].is_warning).toBe(1);
});

test("getFullResults joins test_metrics into each result row (grouped by stage)", () => {
  db.createRun({
    job_id: "job-5",
    org_id: "o",
    user_id: "u",
    ai_feature: "calc",
    runner_name: "ect-server",
    config: {},
  });
  db.insertTestResult({
    job_id: "job-5",
    test_case_id: "calc-1",
    runner: "ect-server",
    datasource: "public-activity-360",
    utterance: "day of week",
    expected: { intent: "NLQ_TO_NEW_CALCULATED_FIELD" },
    actual: {
      intent: "NLQ_TO_NEW_CALCULATED_FIELD",
      calculatedFieldFormula: { formula: "DATENAME('weekday', [Activity Date])" },
    },
    latency: 0.5,
  });
  // A second case with no metrics → its row.metrics must be an empty map,
  // not null/absent.
  db.insertTestResult({
    job_id: "job-5",
    test_case_id: "calc-2",
    runner: "ect-server",
    datasource: "public-activity-360",
    utterance: "profit",
    expected: null,
    actual: null,
    latency: null,
  });
  db.insertTestMetrics("job-5", "calc-1", "intent", [
    { metric_id: "eq", metric_name: "equals", score: 1.0, explanation: null },
  ]);
  db.insertTestMetrics("job-5", "calc-1", "calculatedFieldFormula", [
    { metric_id: "cv", metric_name: "calcValidity", score: 1.0, explanation: "valid" },
    { metric_id: "fp", metric_name: "fieldPrecision", score: 0.5, explanation: null },
  ]);

  const full = db.getFullResults("job-5")!;
  expect(full).not.toBeNull();
  // top-level flat metrics list preserved for the static-results client path.
  expect(full.metrics.length).toBe(3);

  const row1 = full.results.find((r) => r.test_case_id === "calc-1")!;
  const byStage = row1.metrics as Record<string, Array<Record<string, unknown>>>;
  expect(byStage).toBeDefined();
  expect(byStage.intent.map((m) => m.metric_name)).toEqual(["equals"]);
  expect(byStage.calculatedFieldFormula.map((m) => m.metric_name)).toEqual([
    "calcValidity",
    "fieldPrecision",
  ]);
  expect(byStage.calculatedFieldFormula[0]!.score).toBeCloseTo(1.0, 6);

  const row2 = full.results.find((r) => r.test_case_id === "calc-2")!;
  expect(row2.metrics).toEqual({});
});

test("persistCaseResult: one-transaction persist of result + metrics + errors", () => {
  db.createRun({
    job_id: "job-6",
    org_id: "o",
    user_id: "u",
    ai_feature: "nlq",
    runner_name: "r",
    config: {},
  });
  db.persistCaseResult(
    {
      job_id: "job-6",
      test_case_id: "tc-1",
      runner: "r",
      datasource: "ds",
      utterance: "u",
      expected: { a: 1 },
      actual: { a: 1 },
      latency: 0.5,
      debug_info: { steps: 2 },
    },
    { calc: [{ metric_id: "m1", metric_name: "calcValidity", score: 1, explanation: null }] },
    [{ phase: "RUN", description: "warn", warning: true }],
  );
  const full = db.getFullResults("job-6")!;
  expect(full.results.length).toBe(1);
  expect(full.results[0].debug_info).toEqual({ steps: 2 });
  expect(full.metrics.length).toBe(1);
  expect(full.metrics[0].metric_name).toBe("calcValidity");
  expect(full.errors.length).toBe(1);
  expect(full.errors[0].description).toBe("warn");
});

test("persistCaseResult: debug_info_json is stored verbatim (pre-serialized path)", () => {
  db.createRun({
    job_id: "job-7",
    org_id: "o",
    user_id: "u",
    ai_feature: "nlq",
    runner_name: "r",
    config: {},
  });
  // Simulate the orchestrator's capDebugInfo: caller pre-serializes debug_info
  // and passes debug_info_json; the DB must store it without re-stringifying.
  const marker = { _truncated: true, _original_bytes: 999, preview: "abc" };
  db.persistCaseResult(
    {
      job_id: "job-7",
      test_case_id: "tc-1",
      runner: "r",
      datasource: null,
      utterance: null,
      expected: null,
      actual: null,
      latency: null,
      debug_info: marker,
      debug_info_json: JSON.stringify(marker),
    },
    {},
    [],
  );
  const full = db.getFullResults("job-7")!;
  expect(full.results[0].debug_info).toEqual(marker);
});

// ---------------------------------------------------------------------------
// runScores — the catalog's weighted overall, cached once a run has ended
// ---------------------------------------------------------------------------

function seedScoredRun(jobId: string, status: string): void {
  db.createRun({
    job_id: jobId,
    org_id: "",
    user_id: "",
    ai_feature: "calc",
    runner_name: "calc-prompt",
    config: {},
  });
  db.updateRunStatus(jobId, status);
  // data (weight 13) at 1.0, design (weight 4) at 0.0 -> 13/17, NOT the
  // plain mean 0.5. A judge metric (weight 0) never moves the overall.
  db.insertTestMetrics(jobId, "tc-1", "vizQuality", [
    { metric_name: "fieldSimilarity", score: 1.0 },
    { metric_name: "aestheticAccuracy", score: 0.0 },
  ]);
  db.insertTestMetrics(jobId, "tc-1", "llmJudge", [
    { metric_name: "coherence", score: 0.1 },
    { metric_name: "insightfulness", score: null },
  ]);
}

test("runScores: weighted catalog overall, not a plain mean", () => {
  seedScoredRun("job-live", "running");
  const s = db.runScores(["job-live"])["job-live"];
  expect(s.score).toBeCloseTo(13 / 17, 9);
  expect(s.scored_metrics).toBe(3);
  // Headline scores: the viz card (data 1.0 + design 0.0 -> 0.5, unweighted
  // card mean), then the judge's NL card — never the blended overall.
  expect(s.headline_scores.map((h) => h.key)).toEqual(["viz", "nl"]);
  expect(s.headline_scores[0].average).toBeCloseTo(0.5, 9);
  // A live run is not cached.
  expect(db.getJobState("job-live").score_version).toBeUndefined();
});

test("runScores: categories are named for the run's capability", () => {
  const job = "cace0000000000000000000000000002";
  db.createRun({
    job_id: job,
    org_id: "",
    user_id: "",
    ai_feature: "prep-calc",
    runner_name: "prep-calc-gen",
    config: {},
  });
  db.insertTestResult({
    job_id: job,
    test_case_id: "tc-1",
    runner: "prep-calc-gen",
    datasource: "ds",
    utterance: "q",
    expected: {},
    actual: {},
    latency: 1.0,
  });
  db.insertTestMetrics(job, "tc-1", "calculatedFieldFormula", [
    { metric_name: "calcValidity", score: 0.5 },
  ]);
  db.updateRunStatus(job, "finished", { total: 1, completed: 1 });
  expect(db.runScores([job])[job].headline_scores).toEqual([
    { key: "calc", label: "Calculated fields in flows", average: 0.5, total_scores: 1, judge_scores: 0 },
  ]);
});

test("runScores: an ended run is computed once and cached in job_state", () => {
  seedScoredRun("job-done", "finished");
  const first = db.runScores(["job-done"])["job-done"];
  expect(first.score).toBeCloseTo(13 / 17, 9);
  const st = db.getJobState("job-done");
  expect(st.score_version).toBe(`4:${mc.fingerprint()}`);
  expect(st.overall_score).toBeCloseTo(13 / 17, 9);
  // The headline scores are cached alongside.
  expect(st.headline_scores).toEqual(first.headline_scores);
  expect(first.headline_scores.map((h) => h.key)).toEqual(["viz", "nl"]);
  // Later metric writes do not move a cached, ended run's score.
  db.insertTestMetrics("job-done", "tc-2", "vizQuality", [
    { metric_name: "fieldSimilarity", score: 0.0 },
  ]);
  expect(db.runScores(["job-done"])["job-done"].score).toBeCloseTo(13 / 17, 9);
});

test("runScores: a run with no metrics has a null score and 0 scored metrics", () => {
  db.createRun({
    job_id: "job-empty",
    org_id: "",
    user_id: "",
    ai_feature: "",
    runner_name: "",
    config: {},
  });
  expect(db.runScores(["job-empty"])["job-empty"]).toEqual({
    score: null,
    scored_metrics: 0,
    headline_scores: [],
  });
  expect(db.runScores([])).toEqual({});
});

test("runScores: cached run scores follow the catalog", () => {
  // The home page keeps each finished run's scores. When the catalog changes
  // (a metric joins a category), a kept score is stale: the results page,
  // which computes in the browser, would show the new average beside the home
  // page's old one.
  const job = "cace0000000000000000000000000001";
  db.createRun({ job_id: job, org_id: "", user_id: "", ai_feature: "calc", runner_name: "ect-server", config: {} });
  db.insertTestMetrics(job, "tc-1", "calculatedFieldFormula", [{ metric_name: "calcValidity", score: 0.5 }]);
  db.updateRunStatus(job, "finished");

  const first = db.runScores([job])[job];
  expect(first.headline_scores).toEqual([
    { key: "calc", label: "Calculated fields", average: 0.5, total_scores: 1, judge_scores: 0 },
  ]);
  expect(String(db.getJobState(job).score_version).endsWith(mc.fingerprint())).toBe(true);

  // Same catalog: the kept score is served as is (tamper with it to see that).
  db.patchJobState(job, { headline_scores: [{ key: "calc", label: "kept", average: 0.1 }] });
  expect(db.runScores([job])[job].headline_scores[0].label).toBe("kept");

  // The catalog changed: the kept score is recomputed and stored again.
  mc._setFingerprintForTest("a-different-catalog");
  try {
    const again = db.runScores([job])[job];
    expect(again.headline_scores).toEqual(first.headline_scores);
    expect(String(db.getJobState(job).score_version).endsWith("a-different-catalog")).toBe(true);
  } finally {
    mc._setFingerprintForTest(null);
  }
});

test("catalog fingerprint follows the catalog's content", () => {
  const parsed = JSON.parse(readFileSync(join(import.meta.dir, "..", "metrics", "catalog.json"), "utf-8"));
  const hash = (v: unknown) =>
    new Bun.CryptoHasher("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
  expect(mc.fingerprint()).toMatch(/^[0-9a-f]{12}$/);
  expect(mc.fingerprint()).toBe(hash(parsed));
  // Any change to the catalog (here: one weight) changes the fingerprint.
  parsed.categories[0].weight += 1;
  expect(hash(parsed)).not.toBe(mc.fingerprint());
});
