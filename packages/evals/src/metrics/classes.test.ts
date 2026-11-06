import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeMetric,
  computeEquals,
  computeSpecFieldAccuracy,
  computeSpecFieldValidity,
  computeCalcValidity,
  computeCalcFieldAccuracy,
  computeConciseness,
  computeReadability,
  computeColorPaletteDistinguishability,
  computeGradientSmoothness,
  computeDivergingPaletteStructure,
  computeGroundTruthColorPalette,
  computeRanx,
  findSubEntries,
  isSentenceRelevantToSubject,
  extractContentFromMarkdown,
  METRIC_REGISTRY,
  type MetricContext,
} from "./classes.ts";
import { detectDateTimeSpans, isDateRelated, type DateEntityDetector } from "./date_entities.ts";
import { computeJudgeMetrics, type JudgeConfig } from "@tableau-ai-eval/core";

const LIB_DIR = join(import.meta.dir, "..", "..", "..", "..", "goldens", "lib");

// ---------------------------------------------------------------------------
// Equals
// ---------------------------------------------------------------------------

describe("Equals", () => {
  test("scalar equality", () => {
    expect(computeEquals({ expected: "NLQ", actual: "NLQ" })[0].score).toBe(1.0);
    expect(computeEquals({ expected: "NLQ", actual: "OTHER" })[0].score).toBe(0.0);
  });

  test("object deep equality (order-independent)", () => {
    const a = { chart: "bar", fields: [1, 2] };
    const b = { fields: [1, 2], chart: "bar" };
    expect(computeEquals({ expected: a, actual: b })[0].score).toBe(1.0);
  });

  test("name override from config", () => {
    const m = computeEquals({ expected: "x", actual: "x", config: { name: "chartEquals" } });
    expect(m[0].metric_name).toBe("chartEquals");
  });

  test("dispatch via registry", () => {
    const m = computeMetric("Equals", { expected: 1, actual: 1 });
    expect(m[0].score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// find_sub_entries + ranx wiring (reuse ir semantics)
// ---------------------------------------------------------------------------

describe("findSubEntries + Ranx wiring", () => {
  test("collects field captions from a notional spec", () => {
    const spec = {
      chart: "bar",
      fields: [
        { caption: "Sales", encoding: "y" },
        { caption: "Year", encoding: "x" },
      ],
    };
    const caps = new Set(findSubEntries(spec, ["field", "caption"]));
    expect(caps).toEqual(new Set(["Sales", "Year"]));
  });

  test("SpecFieldAccuracy precision/recall over field captions", () => {
    // expected {Sales, Year, Region}; actual {Sales, Year, Category}
    const expected = { fields: [{ caption: "Sales" }, { caption: "Year" }, { caption: "Region" }] };
    const actual = { fields: [{ caption: "Sales" }, { caption: "Year" }, { caption: "Category" }] };
    const m = computeSpecFieldAccuracy({ expected, actual, utterance: "q" });
    const byName = Object.fromEntries(m.map((x) => [x.metric_name, x.score]));
    // 2 of 3 actual match -> precision 2/3; 2 of 3 expected covered -> recall 2/3
    expect(byName.precision).toBeCloseTo(2 / 3, 9);
    expect(byName.recall).toBeCloseTo(2 / 3, 9);
  });

  test("SpecFieldAccuracy empty expected => []", () => {
    expect(computeSpecFieldAccuracy({ expected: {}, actual: { fields: [{ caption: "X" }] } })).toEqual([]);
  });

  test("SpecFieldAccuracy empty actual => 0.0 per metric", () => {
    const m = computeSpecFieldAccuracy({ expected: { fields: [{ caption: "X" }] }, actual: {} });
    expect(m.map((x) => x.score)).toEqual([0.0, 0.0]);
  });

  test("SpecFieldValidity renames metric to fieldValidity", () => {
    const m = computeSpecFieldValidity({
      datasourceFields: [{ caption: "Sales" }, { caption: "Year" }],
      actual: { fields: [{ caption: "Sales" }, { caption: "Ghost" }] },
    });
    expect(m[0].metric_name).toBe("fieldValidity");
    // 1 of 2 actual present in datasource -> precision 0.5
    expect(m[0].score).toBeCloseTo(0.5, 9);
  });

  test("CalcFieldAccuracy renames precision/recall to fieldPrecision/fieldRecall", () => {
    const m = computeCalcFieldAccuracy({
      parsedExpectedFields: ["A", "B"],
      parsedActualFields: ["A", "C"],
    });
    const names = m.map((x) => x.metric_name).sort();
    expect(names).toEqual(["fieldPrecision", "fieldRecall"]);
  });
});

// ---------------------------------------------------------------------------
// Ranx tie fixture (reuse ir golden values through the class-level wiring)
// ---------------------------------------------------------------------------

describe("computeRanx preserves ir.ts golden semantics", () => {
  const ranxGolden = JSON.parse(readFileSync(join(LIB_DIR, "ranx_ir", "expected.json"), "utf8")) as {
    cases: { name: string; metrics?: Record<string, number> }[];
  };
  const ranxInputs = JSON.parse(readFileSync(join(LIB_DIR, "ranx_ir", "inputs.json"), "utf8")) as {
    cases: { name: string; qrels: Record<string, Record<string, number>>; run: Record<string, Record<string, number>> }[];
  };

  // Prove the class-level ranx wiring reproduces the ir golden for a
  // precision/recall case (the field-accuracy metrics build on exactly this).
  test("clean case precision/recall matches golden", () => {
    const inputCase = ranxInputs.cases.find((c) => c.name === "clean_top_ranked_relevant");
    const expectedCase = ranxGolden.cases.find((c) => c.name === "clean_top_ranked_relevant");
    if (!inputCase || !expectedCase || expectedCase.metrics?.precision === undefined) {
      // Golden shape differs; skip gracefully.
      return;
    }
    // qrels/run are nested by query key; unwrap the single query.
    const qKey = Object.keys(inputCase.qrels)[0];
    const qrels: Record<string, number> = inputCase.qrels[qKey];
    const run: Record<string, number> = inputCase.run[qKey];
    const expectedPairs = Object.entries(qrels).map(([k, v]) => [k, v] as [string, number]);
    const actualPairs = Object.entries(run).map(([k, v]) => [k, v] as [string, number]);
    const m = computeRanx(expectedPairs, actualPairs, ["precision", "recall"], "q");
    const byName = Object.fromEntries(m.map((x) => [x.metric_name, x.score]));
    expect(byName.precision).toBeCloseTo(expectedCase.metrics.precision, 6);
    if (expectedCase.metrics.recall !== undefined) {
      expect(byName.recall).toBeCloseTo(expectedCase.metrics.recall, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// CalcValidity (wraps TableauValidator)
// ---------------------------------------------------------------------------

describe("CalcValidity", () => {
  const ds = [
    { caption: "Sales", datatype: "real" },
    { caption: "Profit", datatype: "real" },
  ];

  test("valid formula -> 1.0", () => {
    const m = computeCalcValidity({ actual: "SUM([Sales])", datasourceFields: ds });
    expect(m[0].metric_name).toBe("calcValidity");
    expect(m[0].score).toBe(1.0);
  });

  test("empty formula -> 0.0 with Empty formula explanation", () => {
    const m = computeCalcValidity({ actual: null, datasourceFields: ds });
    expect(m[0].score).toBe(0.0);
    expect(m[0].explanation).toBe("Empty formula");
  });

  test("syntactically invalid formula -> 0.0", () => {
    const m = computeCalcValidity({ actual: "SUM([Sales]", datasourceFields: ds });
    expect(m[0].score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// ConcisenessScorer (reuses tfidf lib primitive)
// ---------------------------------------------------------------------------

describe("ConcisenessScorer (TF-IDF over sentences)", () => {
  const md = (text: string) => JSON.stringify({ sections: [{ body: text }] });

  test("redundant narrative -> lower conciseness (matches Python 0.7778)", () => {
    const m = computeConciseness({
      actual: md("Sales grew across every region. Sales grew across every region. Profit stayed flat."),
    });
    expect(m[0].metric_name).toBe("Conciseness");
    expect(m[0].score).toBeCloseTo(0.7778, 4);
  });

  test("disjoint sentences -> conciseness 1.0", () => {
    const m = computeConciseness({ actual: JSON.stringify({ body: "apple banana cherry. xylophone yacht zebra." }) });
    expect(m[0].score).toBeCloseTo(1.0, 4);
  });

  test("single sentence -> 1.0", () => {
    const m = computeConciseness({ actual: JSON.stringify({ body: "Only one sentence here" }) });
    expect(m[0].score).toBeCloseTo(1.0, 4);
  });

  test("empty text -> 1.0", () => {
    const m = computeConciseness({ actual: JSON.stringify({ body: "" }) });
    expect(m[0].score).toBe(1.0);
  });

  test("extractContentFromMarkdown collects nested body values", () => {
    const text = extractContentFromMarkdown(JSON.stringify({ a: { body: "one" }, b: [{ body: "two" }] }));
    expect(text).toBe("one two");
  });
});

// ---------------------------------------------------------------------------
// ReadabilityScorer (Flesch via flesch.ts punkt substitute) — tolerance-relaxed
// ---------------------------------------------------------------------------

describe("ReadabilityScorer (Flesch; punkt-substitute divergence)", () => {
  test("short (<100 words) narrative -> 1.0 fallback", () => {
    const m = computeReadability({ actual: JSON.stringify({ body: "Sales rose. Profit fell." }) });
    expect(m[0].metric_name).toBe("Readability (Flesch)");
    expect(m[0].score).toBe(1.0);
  });

  test("score is clamped to [0,1] (Python div100 can exceed range)", () => {
    // A long, complex text yields a Flesch/100 possibly <0 or >1; the
    // ComputedMetric contract clamps. This documents divergence from Python's
    // raw stored value (which would violate its own 0..1 assert).
    const longText = Array(60).fill("The quarterly analysis demonstrates substantial complexity.").join(" ");
    const m = computeReadability({ actual: JSON.stringify({ body: longText }) });
    expect(m[0].score).toBeGreaterThanOrEqual(0.0);
    expect(m[0].score).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// Color palette metrics (reuse ciede2000 lib primitive)
// ---------------------------------------------------------------------------

describe("Color palette metrics (CIEDE2000)", () => {
  test("ColorPaletteDistinguishability only runs for regular palettes", () => {
    expect(computeColorPaletteDistinguishability({ paletteType: "sequential", colors: ["#fff"] })).toEqual([]);
    const m = computeColorPaletteDistinguishability({
      paletteType: "regular",
      colors: ["#ff0000", "#00ff00", "#0000ff"],
    });
    expect(m[0].metric_name).toBe("distinguishability");
    expect(m[0].score).toBe(1.0); // all pairs well above threshold 10
  });

  test("GradientSmoothness matches Python (~0.7879)", () => {
    const m = computeGradientSmoothness({
      paletteType: "sequential",
      colors: ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"],
    });
    expect(m[0].metric_name).toBe("gradientSmoothness");
    expect(m[0].score).toBeCloseTo(0.787931306275, 6);
  });

  test("GradientSmoothness single step -> 1.0", () => {
    const m = computeGradientSmoothness({ paletteType: "sequential", colors: ["#000000", "#ffffff"] });
    expect(m[0].score).toBe(1.0);
  });

  test("DivergingPaletteStructure matches Python (1.0)", () => {
    const m = computeDivergingPaletteStructure({
      paletteType: "diverging",
      colors: ["#d73027", "#fee08b", "#1a9850"],
    });
    expect(m[0].metric_name).toBe("divergingStructure");
    expect(m[0].score).toBeCloseTo(1.0, 6);
  });

  test("DivergingPaletteStructure <3 colors -> 0.0", () => {
    const m = computeDivergingPaletteStructure({ paletteType: "diverging", colors: ["#000", "#fff"] });
    expect(m[0].score).toBe(0.0);
  });

  test("GroundTruthColorPaletteEvaluation greedy match matches Python (~0.9797)", () => {
    const m = computeGroundTruthColorPalette({
      expected: ["#ff0000", "#00ff00"],
      colors: ["#fe0000", "#00fe00", "#0000ff"],
      paletteType: "regular",
    });
    expect(m[0].metric_name).toBe("groundTruthValidity");
    expect(m[0].score).toBeCloseTo(0.9797474200908504, 6);
  });
});

// ---------------------------------------------------------------------------
// Fuzzy subject-relevance (reuses fuzzy lib primitive)
// ---------------------------------------------------------------------------

describe("isSentenceRelevantToSubject (rapidfuzz wiring)", () => {
  test("relevant subject sentence passes threshold", () => {
    expect(isSentenceRelevantToSubject("total revenue", "the total revenue was high", 0.45)).toBe(true);
  });

  test("comma phrases: max over phrases", () => {
    expect(isSentenceRelevantToSubject("east, west region", "sales in the west region", 0.45)).toBe(true);
  });

  test("irrelevant subject fails threshold", () => {
    expect(isSentenceRelevantToSubject("quantum physics", "the total revenue was high", 0.45)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NER date detector (injectable substitute) — wiring + divergence
// ---------------------------------------------------------------------------

describe("date entity detector (spaCy substitute; tolerance-relaxed)", () => {
  const ner = JSON.parse(readFileSync(join(LIB_DIR, "ner_dates", "expected.json"), "utf8")) as {
    sentences: { text: string; date_time_spans: { start_char: number; end_char: number }[] }[];
  };

  test("default regex detector: DATE/TIME spans overlap spaCy on temporal cases", () => {
    // Compare LABEL membership + overlapping spans, NOT exact
    // offsets. For each golden case that spaCy marked as DATE/TIME, the regex
    // detector should also produce >=1 overlapping DATE/TIME span; for the
    // non-temporal cases (plain_number, no_temporal) it should produce none.
    for (const s of ner.sentences) {
      const spans = detectDateTimeSpans(s.text);
      const spacyHasTemporal = s.date_time_spans.length > 0;
      if (spacyHasTemporal) {
        // At least one detected span overlaps a spaCy DATE/TIME span.
        const overlaps = s.date_time_spans.some((gold) =>
          spans.some((d) => d.startChar < gold.end_char && d.endChar > gold.start_char),
        );
        expect(overlaps).toBe(true);
      } else {
        // plain_number / no_temporal — MONEY/PERCENT, not date. Regex detector
        // must not fabricate a DATE/TIME span. (Divergence-safe assertion.)
        expect(spans.length).toBe(0);
      }
    }
  });

  test("isDateRelated: number inside a detected span", () => {
    const text = "Revenue grew in January 2024 by a wide margin.";
    const spans = detectDateTimeSpans(text);
    // "2024" (index 24..28) is inside the January 2024 DATE span.
    const idx = text.indexOf("2024");
    expect(isDateRelated(spans, idx, idx + 4)).toBe(true);
    // "121" style number outside any span -> false
    expect(isDateRelated(spans, 0, 3)).toBe(false);
  });

  test("detector is injectable (fake detector wired through isDateRelated)", () => {
    const fake: DateEntityDetector = (text: string) =>
      text.includes("FOO") ? [{ text: "FOO", label: "DATE", startChar: 0, endChar: 3 }] : [];
    const spans = fake("FOO bar");
    expect(spans.length).toBe(1);
    expect(isDateRelated(spans, 0, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Judge-backed wiring (inject a fake fetch, assert the judge path is wired)
// ---------------------------------------------------------------------------

describe("judge-backed metric wiring (fake judge)", () => {
  test("computeJudgeMetrics with injected fetch returns parsed scores", async () => {
    const cfg: JudgeConfig = { provider: "openai", api_key: "sk-test", model: "gpt-4o" };
    const fakeResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              coherence: { score: 0.9, reason: "clear" },
              insightfulness: { score: 0.5, reason: "ok" },
              factualGrounding: { score: 0.8, reason: "grounded" },
              followUpRelevance: { score: 0.6, reason: "opens follow-up" },
            }),
          },
        },
      ],
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify(fakeResponse), { status: 200 })) as unknown as typeof fetch;

    const metrics = await computeJudgeMetrics(
      { utterance: "Show sales by year", expectedReply: "Sales rose.", actualReply: "Sales increased.", judgeCfg: cfg },
      { fetchFn },
    );
    const byName = Object.fromEntries(metrics.map((m) => [m.metric_name, m.score]));
    expect(byName.coherence).toBeCloseTo(0.9, 6);
    expect(byName.insightfulness).toBeCloseTo(0.5, 6);
    expect(byName.factualGrounding).toBeCloseTo(0.8, 6);
    expect(byName.followUpRelevance).toBeCloseTo(0.6, 6);
  });

  test("unconfigured judge returns [] (not requested)", async () => {
    const metrics = await computeJudgeMetrics(
      { utterance: "q", actualReply: "a", judgeCfg: {} },
      {},
    );
    expect(metrics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Registry completeness / dispatch
// ---------------------------------------------------------------------------

describe("registry", () => {
  test("known deterministic metrics are registered", () => {
    const names = [
      "Equals",
      "SpecFieldAccuracy",
      "SpecFieldValidity",
      "CalcValidity",
      "CalcFieldValidity",
      "CalcFieldAccuracy",
      "CalcValueAccuracy",
      "ConcisenessScorer",
      "ReadabilityScorer",
      "ColorPaletteDistinguishability",
      "GradientSmoothness",
      "DivergingPaletteStructure",
      "GroundTruthColorPaletteEvaluation",
    ];
    for (const n of names) expect(typeof METRIC_REGISTRY[n]).toBe("function");
  });

  test("unknown metric name throws (mirrors globals()[metric] KeyError)", () => {
    expect(() => computeMetric("NoSuchMetric", {} as MetricContext)).toThrow(/Unsupported metric/);
  });
});
