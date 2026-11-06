/**
 * The metric catalog: one file, two readers, one set of numbers. Runs the shared
 * parity fixture (`goldens/metric_catalog/metric_parity.json`, byte-identical
 * to `goldens/metric_catalog/metric_parity.json`, whose expected
 * values captured from an independent reference).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mc from "./catalog.ts";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const FIXTURE = JSON.parse(
  readFileSync(join(REPO, "goldens", "metric_catalog", "metric_parity.json"), "utf-8"),
) as {
  rows: Record<string, mc.StageMetrics>;
  expected: {
    per_row: Record<string, Expected>;
    aggregates: Record<string, Expected & { rows: string[] }>;
  };
};

interface Expected {
  buckets: Record<string, number | null>;
  unweighted: number | null;
  overall: number | null;
  verdict?: string;
  cards: Record<string, number | null>;
}

const avgs = (b: mc.Bucket[]) => Object.fromEntries(b.map((x) => [x.def.key, x.avg]));

function close(a: number | null | undefined, b: number | null) {
  if (b === null) expect(a ?? null).toBeNull();
  else expect(Math.abs((a as number) - b)).toBeLessThan(1e-9);
}

function same(got: Record<string, number | null>, want: Record<string, number | null>) {
  expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  for (const k of Object.keys(want)) close(got[k], want[k]);
}

describe("scoring parity with the metric parity fixture", () => {
  for (const [key, sm] of Object.entries(FIXTURE.rows)) {
    test(`row ${key}`, () => {
      const exp = FIXTURE.expected.per_row[key];
      const b = mc.computeRowBuckets(sm);
      same(avgs(b), exp.buckets);
      close(mc.bucketOverall(b), exp.unweighted);
      const overall = mc.weightedOverall(b);
      close(overall, exp.overall);
      expect(mc.verdict(overall)).toBe(exp.verdict as mc.Verdict);
      same(mc.cardScores(b), exp.cards);
    });
  }
  for (const [name, exp] of Object.entries(FIXTURE.expected.aggregates)) {
    test(`aggregate ${name}`, () => {
      const b = mc.computeAggregateBuckets(exp.rows.map((k) => FIXTURE.rows[k]));
      same(avgs(b), exp.buckets);
      close(mc.bucketOverall(b), exp.unweighted);
      close(mc.weightedOverall(b), exp.overall);
      same(mc.cardScores(b), exp.cards);
    });
  }
});

const leafOf = (catKey: string, label: string) =>
  mc.categories().find((c) => c.key === catKey)!.metrics.find((l) => l.label === label)!;

test("scoring rules spelled out", () => {
  // The first alias WITH a score wins over an earlier null one. (No
  // catalogued metric carries an alias today; the rule stays for the next
  // renamed metric.)
  let sm: mc.StageMetrics = {
    calculatedFieldFormula: [
      { metric_name: "calcValidity", score: null, explanation: "Unavailable" },
      { metric_name: "calcValid", score: 1.0 },
    ],
  };
  const calcLeaf = { stage: "calculatedFieldFormula", names: ["calcValidity", "calcValid"], label: "Calculation Validity" };
  expect(mc.resolveLeaf(sm, calcLeaf)!.value).toBe(1.0);
  // Present with a null score = Unavailable; absent resolves to nothing.
  sm = { llmJudge: [{ metric_name: "coherence", score: null, explanation: "503" }] };
  const coh = leafOf("nlConversation", "Coherence");
  const r = mc.resolveLeaf(sm, coh)!;
  expect(r.present).toBe(true);
  expect(r.value).toBeNull();
  expect(r.judge).toBe(true);
  expect(mc.resolveLeaf({}, coh)).toBeNull();
  // Nulls excluded from averages; zero-weight categories never enter overall.
  let b = mc.computeRowBuckets({
    llmJudge: [
      { metric_name: "coherence", score: null },
      { metric_name: "followUpRelevance", score: 0.5 },
    ],
  });
  expect(avgs(b)).toEqual({ nlConversation: 0.5 });
  expect(mc.weightedOverall(b)).toBeNull();
  expect(mc.verdict(null)).toBe("na");
  // data (13) at 1.0 and design (4) at 0.0 -> 13/17.
  b = mc.computeAggregateBuckets([
    {
      vizQuality: [
        { metric_name: "fieldSimilarity", score: 1.0 },
        { metric_name: "aestheticAccuracy", score: 0.0 },
      ],
    },
  ]);
  close(mc.weightedOverall(b), 13 / 17);
  const t = mc.thresholds();
  expect(mc.verdict(t.pass)).toBe("pass");
  expect(mc.verdict(t.partial)).toBe("partial");
  expect(mc.verdict(t.partial - 0.01)).toBe("fail");
  expect(t.provisional).toBe(true);
});

test("headline scores are the capability measures, not a blend", () => {
  //: the viz card, then weighted stand-alone categories heaviest
  // first, then the judge's card.
  const rows = FIXTURE.rows;
  const viz = mc.headlineScores(mc.computeAggregateBuckets([rows.viz_full]));
  // Intent and Spec rides with the Visualization Quality headline for
  // reference (not in its average, not a headline of its own; 4f59fd01).
  expect(viz.map((h) => h.key)).toEqual(["viz", "nl"]);
  expect(viz[0].label).toBe("Visualization quality");
  expect(viz[viz.length - 1].label).toBe("Natural language quality");
  expect(viz.every((h) => h.average !== null && h.average !== undefined)).toBe(true);
  expect(viz[0].context!.map((c) => c.key)).toEqual(["match"]);
  expect(viz[0].context![0]!.label).toBe("Intent and spec");
  expect(viz[1].context).toBeUndefined();

  const calcBuckets = mc.computeAggregateBuckets([rows.calc_alias, rows.calc_direct]);
  const calc = mc.headlineScores(calcBuckets);
  // Without a Visualization Quality card to ride with, Intent and Spec is a
  // headline of its own (a calculation run).
  expect(calc.map((h) => h.key)).toEqual(["calc", "match"]);
  expect(calc[0].label).toBe("Calculated fields");
  // The blend is a different number from any headline.
  expect(calc.map((h) => h.average)).not.toContain(mc.weightedOverall(calcBuckets) as number);

  const palette = mc.headlineScores(mc.computeAggregateBuckets([rows.palette]));
  expect(palette.map((h) => h.key)).toEqual(["palette"]);
  // Each headline says how many metrics it averages and how many of them the
  // judge scored, so a judge-on run is not read against a judge-off one.
  expect([palette[0].total_scores, palette[0].judge_scores]).toEqual([5, 3]);
  // The NL card: three judge metrics plus Information Similarity, which is deterministic.
  expect([viz[viz.length - 1].total_scores, viz[viz.length - 1].judge_scores]).toEqual([4, 3]);
  expect(calc[0].judge_scores).toBe(0);
  expect(calc[0].total_scores).toBeGreaterThan(0);
  expect(mc.headlineScores(mc.computeAggregateBuckets([rows.empty]))).toEqual([]);
});

// A category is named as the
// run's capability names it.
test("category label follows the capability", () => {
  expect(mc.categoryLabel("calc")).toBe("Calculated fields");
  expect(mc.categoryLabel("calc", "calc")).toBe("Calculated fields");
  expect(mc.categoryLabel("calc", "prep-calc")).toBe("Calculated fields in flows");
  expect(mc.categoryLabel("match", "prep-calc")).toBe("Intent and spec");
  expect(mc.categoryLabel("no-such-category", "prep-calc")).toBe("no-such-category");
});

test("headline scores name the category for the capability", () => {
  const buckets = () =>
    mc.computeAggregateBuckets([
      { calculatedFieldFormula: [{ metric_name: "calcValidity", score: 0.5 }] },
    ]);
  const plain = mc.headlineScores(buckets());
  const prep = mc.headlineScores(buckets(), "prep-calc");
  expect(plain.map((h) => h.label)).toEqual(["Calculated fields"]);
  expect(prep.map((h) => h.label)).toEqual(["Calculated fields in flows"]);
  expect(plain.map((h) => h.average)).toEqual(prep.map((h) => h.average));
});

test("metric dictionary and unknown metrics", () => {
  const d = mc.metricDictionary();
  const calc = d["calculatedFieldFormula.calcValidity"];
  expect(calc.label).toBe("Calculation Validity");
  expect(calc.category).toBe("Calculated fields");
  expect(calc.category_weight).toBe(13);
  expect(calc.judge_derived).toBe(false);
  expect(calc.meaning).toBeTruthy();
  // Only names a runner emits are entries: no "equals" under the formula stage.
  expect(d["calculatedFieldFormula.equals"]).toBeUndefined();
  expect(d["llmJudge.coherence"].judge_derived).toBe(true);
  expect(mc.describeMetric("somethingElse", "mystery")).toEqual({
    label: "mystery",
    category: "Other",
    category_key: "other",
    category_weight: 0,
    judge_derived: false,
    meaning: "",
  });
  expect(mc.describeMetric("llmJudge", "novelJudgeMetric").judge_derived).toBe(true);
  expect(mc.capabilityLabel("calc")).toBe("Calculated fields");
  expect(mc.capabilityLabel("made-up")).toBe("made-up");
  expect(mc.capabilityLabel(null)).toBe("");
});

test("every catalogued metric has a meaning", () => {
  const missing = mc
    .categories()
    .flatMap((c) => c.metrics)
    .filter((l) => !mc.explanationFor(l.label))
    .map((l) => l.label);
  expect(missing).toEqual([]);
});

test("frontend copy of the catalog is byte-identical", () => {
  // The results page reads packages/frontend/src/metricCatalog.json; a stale
  // copy means the page and the exports disagree about a weight or a label.
  // Refresh with `bun run scripts/build-frontend.ts` (it syncs first).
  const core = readFileSync(join(import.meta.dir, "catalog.json"));
  const fe = readFileSync(join(REPO, "packages", "frontend", "src", "metricCatalog.json"));
  expect(fe.equals(core)).toBe(true);
});

// ---------------------------------------------------------------------------
// Score every capability: every metric a runner writes is in the
// catalog, and one fully right case of each capability scores 1.0 / pass.
// ---------------------------------------------------------------------------

// Every metric a runner writes today: the evaluator metric configs, the
// tool's own scorers (viz quality, the judges, palettes) and the Prep and
// dashboard Q&A adapters.
const RUNNER_METRICS: Array<[string, string]> = [
  ["intent", "equals"],
  ["notionalSpec", "precision"], ["notionalSpec", "recall"],
  ["notionalSpec", "fieldValidity"],
  ["vizQuality", "fieldSimilarity"], ["vizQuality", "chartSimilarity"],
  ["vizQuality", "filterAccuracy"], ["vizQuality", "sortAccuracy"], ["vizQuality", "axisAccuracy"],
  ["vizQuality", "aestheticAccuracy"], ["vizQuality", "tooltipAccuracy"],
  ["vizQuality", "informationSimilarity"],
  ["calculatedFieldFormula", "calcValidity"], ["calculatedFieldFormula", "calcFieldValidity"],
  ["calculatedFieldFormula", "fieldPrecision"], ["calculatedFieldFormula", "fieldRecall"],
  ["calculatedFieldFormula", "valuePrecision"], ["calculatedFieldFormula", "valueRecall"],
  ["calculatedFieldFormula", "levenshteinSimilarity"],
  ["flowPlan", "planSimilarity"], ["flowPlan", "stepRecall"], ["flowPlan", "stepPrecision"],
  ["llmJudge", "answerCorrectness"], ["llmJudge", "factualConsistency"],
  ["llmJudge", "factualGrounding"], ["llmJudge", "insightfulness"],
  ["llmJudge", "coherence"], ["llmJudge", "followUpRelevance"],
  ["llmJudge", "valid"], ["llmJudge", "relevance"], ["llmJudge", "design"],
  ["colorPalette", "distinguishability"], ["colorPalette", "gradientSmoothness"],
  ["colorPalette", "divergingStructure"], ["colorPalette", "groundTruthValidity"],
  ["insightNarrative", "llmIsSimilar"], ["insightNarrative", "Conciseness"],
];

describe("every runner metric is catalogued", () => {
  for (const [stage, name] of RUNNER_METRICS) {
    test(`${stage}.${name}`, () => {
      // A metric outside the catalog exports as category "Other" under its
      // raw name and counts toward nothing.
      const info = mc.describeMetric(stage, name);
      expect(info.category).not.toBe("Other");
      expect(info.label !== name || name.includes(" ") || name[0] === name[0]!.toUpperCase()).toBe(true);
      expect(info.meaning).toBeTruthy();
    });
  }
});

test("every capability gets a case score", () => {
  const one = (n: string) => ({ metric_name: n, score: 1.0 });
  const capabilities: Record<string, mc.StageMetrics> = {
    calc: { intent: [one("equals")], calculatedFieldFormula: [one("calcValidity"), one("calcFieldValidity")] },
    "viz-authoring": { notionalSpec: [one("precision"), one("fieldValidity")], vizQuality: [one("fieldSimilarity")] },
    palettes: { llmJudge: [one("valid")], colorPalette: [one("distinguishability")] },
    "dashboard-narratives": { insightNarrative: [one("llmIsSimilar")] },
    "dashboard-qa": { dashboardQA: [one("outputTypeMatch")], llmJudge: [one("answerCorrectness")] },
    "prep-calc": { calculatedFieldFormula: [one("calcValidity"), one("levenshteinSimilarity")] },
    "prep-flow-plan": { flowPlan: [one("planSimilarity")] },
    "prep-intent": { intent: [one("equals")] },
  };
  expect(Object.keys(capabilities).sort()).toEqual(Object.keys(mc.loadCatalog().capabilities).sort());
  for (const [capability, metrics] of Object.entries(capabilities)) {
    const overall = mc.weightedOverall(mc.computeRowBuckets(metrics));
    expect({ capability, overall }).toEqual({ capability, overall: 1.0 });
    expect(mc.verdict(overall)).toBe("pass");
    expect(mc.headlineScores(mc.computeAggregateBuckets([metrics])).length).toBeGreaterThan(0);
  }
  // Every category shown as a card has its explanation.
  const cards = (mc.loadCatalog() as unknown as { card_explanations: Record<string, string> }).card_explanations;
  for (const key of ["calc", "match", "palette", "narrative", "flowPlan", "dashboardQA", "viz", "nl"]) {
    expect(cards[key]).toBeTruthy();
  }
});
