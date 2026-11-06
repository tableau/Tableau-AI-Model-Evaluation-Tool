import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeToolMetrics,
  stem,
  levenshtein,
  semanticSimilarity,
  showMeRecommendations,
  informationSimilarity,
  NO_SPEC_EXPLANATION,
  type ComputedVizMetric,
} from "./viz.ts";

/**
 * Faithfulness tests for src/metrics/viz.ts against the golden generated
 * captured from an independent reference scorer
 * (goldens/viz/expected.json).
 *
 * The TS port must reproduce metric names, scores (float tolerance) and the
 * prose explanations exactly.
 */

const GOLDEN_DIR = join(import.meta.dir, "..", "..", "..", "..", "goldens", "viz");

interface InputCase {
  name: string;
  expected: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  expected_reply?: string | null;
  actual_reply?: string | null;
}

interface ExpectedCase {
  name: string;
  metrics: ComputedVizMetric[];
}

const inputs = JSON.parse(readFileSync(join(GOLDEN_DIR, "inputs.json"), "utf8")) as {
  cases: InputCase[];
};
const expected = JSON.parse(readFileSync(join(GOLDEN_DIR, "expected.json"), "utf8")) as {
  cases: ExpectedCase[];
};

const inputByName = new Map(inputs.cases.map((c) => [c.name, c]));

// Float tolerance for scores (README tolerance class: cosine/Levenshtein noise).
const FLOAT_TOL = 1e-9;

describe("viz golden parity", () => {
  for (const golden of expected.cases) {
    test(golden.name, () => {
      const input = inputByName.get(golden.name);
      expect(input).toBeDefined();
      const got = computeToolMetrics(input!.expected, input!.actual, {
        expectedReply: input!.expected_reply ?? null,
        actualReply: input!.actual_reply ?? null,
      });

      // Same number of metrics, same order, same names.
      expect(got.length).toBe(golden.metrics.length);
      for (let i = 0; i < golden.metrics.length; i++) {
        const g = golden.metrics[i];
        const a = got[i];
        expect(a.metric_id).toBe(g.metric_id);
        expect(a.metric_name).toBe(g.metric_name);
        expect(a.score).toBeCloseTo(g.score, 9);
        expect(Math.abs(a.score - g.score)).toBeLessThanOrEqual(FLOAT_TOL + 1e-7);
        expect(a.explanation).toBe(g.explanation);
      }
    });
  }
});

describe("viz helper primitives", () => {
  test("stem strips common suffixes and non-letters", () => {
    expect(stem("Sales")).toBe("sal");
    expect(stem("running")).toBe("runn");
    expect(stem("Order Date")).toBe("orderdate");
    expect(stem("categories")).toBe("categor");
    expect(stem("")).toBe("");
    expect(stem(null as unknown as string)).toBe("");
    // Short words below suffix+2 threshold are not stripped.
    expect(stem("is")).toBe("is");
  });

  test("levenshtein basic distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  test("semanticSimilarity exact stem match is 1.0", () => {
    expect(semanticSimilarity("Sales", "sales")).toBe(1.0);
    expect(semanticSimilarity("", "x")).toBe(0.0);
  });

  test("semanticSimilarity type bump", () => {
    // Non-matching stems get a +0.1 bump when data types match, clamped to 1.
    const noType = semanticSimilarity("Sale", "Sales");
    const withType = semanticSimilarity("Sale", "Sales", "number", "number");
    expect(withType).toBeGreaterThanOrEqual(noType);
  });

  test("showMeRecommendations time+measure => line", () => {
    const [best, plausible] = showMeRecommendations([
      { data: "date", role: "dimension" },
      { data: "number", role: "measure" },
    ]);
    expect(best).toBe("line");
    expect(plausible).toContain("line");
    expect(plausible).toContain("area");
    expect(plausible).toContain("bar");
  });

  test("showMeRecommendations empty => text", () => {
    const [best, plausible] = showMeRecommendations([]);
    expect(best).toBe("text");
    expect(plausible).toEqual(["text"]);
  });

  test("informationSimilarity identical replies is 1.0", () => {
    expect(informationSimilarity("total revenue rose", "total revenue rose")).toBeCloseTo(1.0, 12);
  });

  test("informationSimilarity disjoint replies is 0.0", () => {
    expect(informationSimilarity("apples oranges", "cars planes")).toBe(0.0);
  });

  test("informationSimilarity empty side is 0.0", () => {
    expect(informationSimilarity("", "anything")).toBe(0.0);
  });
});

describe("viz edge cases", () => {
  test("neither side has a notional spec => []", () => {
    expect(computeToolMetrics({}, {})).toEqual([]);
    expect(computeToolMetrics(null, null)).toEqual([]);
  });

  test("expected spec, no actual spec => every chart metric forced to 0", () => {
    const got = computeToolMetrics(
      { notionalSpec: { chart: "bar", fields: [{ caption: "X", encoding: "x", data: "string" }] } },
      { notionalSpec: null },
    );
    expect(got.map((m) => m.metric_name)).toEqual([
      "chartSimilarity",
      "fieldSimilarity",
      "filterAccuracy",
      "sortAccuracy",
      "axisAccuracy",
      "aestheticAccuracy",
      "tooltipAccuracy",
      "informationSimilarity",
    ]);
    for (const m of got.slice(0, 7)) {
      expect(m.score).toBe(0.0);
      expect(m.explanation).toBe(NO_SPEC_EXPLANATION);
    }
  });

  // A case the suite ships without an expected chart is
  // not scored against an empty chart.
  test("no expected chart => no entries", () => {
    expect(
      computeToolMetrics({ notionalSpec: null }, { notionalSpec: { chart: "bar", fields: [{ caption: "X" }] } }),
    ).toEqual([]);
  });
});
