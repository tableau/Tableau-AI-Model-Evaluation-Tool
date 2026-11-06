/**
 * Golden fixtures pin deterministic palette metrics and explanations.
 *
 * `goldens/color-palette/palette_metric_parity.json` holds
 * 103 palettes scored by the evaluator's palette metric classes: the 68
 * palettes of two recorded Color palettes runs, plus edge cases (invalid
 * colors, too few colors, identical colors, expected colors of a different
 * length, a palette that is not a list). Each entry is
 * `{palette_type, expected, actual, metrics, errors}`. It is an answer key:
 * update it only when the scoring is changed on purpose.
 *
 * Ground-truth scale: `groundTruthValidity` is the
 * tool's own scale (same color up to Delta E 5, one half at 25, each expected
 * color scored on its own, ordered palettes paired by relative position).
 * The "ground truth scale" test below pins these values.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RowError } from "@tableau-ai-eval/core";
import { deltaECIE2000 } from "./lib/ciede2000.ts";
import { colorMatchScore, computePaletteMetrics, paletteHexToLab } from "./palette_metrics.ts";

const FIXTURE = join(
  import.meta.dir, "..", "..", "..", "..", "goldens", "color-palette", "palette_metric_parity.json",
);

interface ParityCase {
  palette_type: string | null;
  expected: unknown;
  actual: unknown;
  metrics: { metric_id: string; metric_name: string; score: number; explanation: string }[];
  errors: RowError[];
}

const cases = (): ParityCase[] => JSON.parse(readFileSync(FIXTURE, "utf-8")).cases;

describe("palette metrics", () => {
  test("scores, explanations and errors match the reference", () => {
    const all = cases();
    expect(all.length).toBe(103);
    const seen = new Set<string>();
    all.forEach((c, i) => {
      const [entries, errors] = computePaletteMetrics(c.palette_type, c.expected, c.actual);
      expect({ i, errors }).toEqual({ i, errors: c.errors });
      expect({ i, e: entries.map((e) => [e.metric_id, e.metric_name, e.explanation]) }).toEqual({
        i,
        e: c.metrics.map((e) => [e.metric_id, e.metric_name, e.explanation]),
      });
      entries.forEach((mine, k) => {
        expect(Math.abs((mine.score as number) - c.metrics[k]!.score)).toBeLessThan(1e-9);
        seen.add(mine.metric_name);
      });
    });
    expect([...seen].sort()).toEqual(
      ["distinguishability", "divergingStructure", "gradientSmoothness", "groundTruthValidity"],
    );
  });

  test("ground truth scale", () => {
    const gt = (t: string, exp: string[], act: string[]) => computePaletteMetrics(t, exp, act)[0].at(-1)!;
    // The exact colors score 1; within Delta E 5 still counts as the same color.
    expect(gt("regular", ["#FF0000"], ["#FF0000"]).score).toBe(1.0);
    expect(colorMatchScore(5.0)).toBe(1.0);
    expect(colorMatchScore(25.0)).toBeCloseTo(0.5, 9);
    expect(colorMatchScore(45.0)).toBeCloseTo(1 / 3, 9);
    // The real flag colors for "American flag colors" are a mostly right answer, not 0.43.
    const flag = gt("regular", ["#FF0000", "#FFFFFF", "#0000FF"], ["#B22234", "#FFFFFF", "#3C3B6E"]);
    expect(flag.score as number).toBeGreaterThan(0.7);
    expect(flag.score as number).toBeLessThan(0.75);
    expect(flag.explanation!.startsWith("Matched 3 of 3 expected colors.")).toBe(true);
    // A 3-color expectation lines up with the ends and the middle of a 7-step answer.
    const seq = gt(
      "sequential",
      ["#FF0000", "#FF7F7F", "#FFFFFF"],
      ["#FF0000", "#FF2A2A", "#FF5555", "#FF7F7F", "#FFAAAA", "#FFD4D4", "#FFFFFF"],
    );
    expect(seq.score).toBe(1.0);
    expect(seq.explanation).toContain("7 colors where 3 were expected");
    // A missing expected color costs its share.
    const short = gt("regular", ["#FF0000", "#0000FF"], ["#FF0000"]);
    expect(short.score as number).toBeCloseTo(0.5, 9);
    expect(short.explanation).toContain("1 expected color(s) found no match");
  });

  test("which checks run follows the palette type", () => {
    const colors = ["#2166AC", "#F7F7F7", "#B2182B"];
    const names = (type: string | null, expected: unknown[] = []) => {
      const [entries, errors] = computePaletteMetrics(type, expected, colors);
      expect(errors).toEqual([]);
      return entries.map((e) => e.metric_name);
    };
    expect(names("regular")).toEqual(["distinguishability"]);
    expect(names("sequential")).toEqual(["gradientSmoothness"]);
    expect(names("diverging")).toEqual(["gradientSmoothness", "divergingStructure"]);
    // Expected colors add the ground-truth check, whatever the type.
    expect(names("regular", ["#0000FF"])).toEqual(["distinguishability", "groundTruthValidity"]);
    expect(names(null)).toEqual([]);
  });

  test("every entry has the row payload shape and a score in range", () => {
    for (const c of cases()) {
      const [entries] = computePaletteMetrics(c.palette_type, c.expected, c.actual);
      for (const e of entries) {
        expect(Object.keys(e).sort()).toEqual(["explanation", "metric_id", "metric_name", "score"]);
        expect(e.score as number).toBeGreaterThanOrEqual(0);
        expect(e.score as number).toBeLessThanOrEqual(1);
      }
    }
  });

  test("color difference reference values", () => {
    expect(deltaECIE2000(paletteHexToLab("#336699"), paletteHexToLab("336699"))).toBe(0);
    expect(deltaECIE2000(paletteHexToLab("#000000"), paletteHexToLab("#FFFFFF"))).toBeCloseTo(100, 4);
    // Published CIEDE2000 test pairs (Sharma, Wu and Dalal 2005, table 1).
    expect(deltaECIE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(deltaECIE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
    expect(deltaECIE2000([50, 2.5, 0], [50, 0, -2.5])).toBeCloseTo(4.3065, 4);
    expect(deltaECIE2000([2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514])).toBeCloseTo(0.9082, 4);
  });

  test.each(["#12345", "#1234567", "", "#GGGGGG", "red"])(
    "a color that is not six hex digits is rejected: %p",
    (bad) => {
      expect(() => paletteHexToLab(bad)).toThrow();
    },
  );
});
