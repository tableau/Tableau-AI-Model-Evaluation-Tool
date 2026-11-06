/**
 * Colour-palette parity golden test (OFFLINE, DETERMINISTIC).
 *
 * Re-scores the identical live-captured palette colors from
 * `goldens/color-palette/case_responses.json` through the TS deterministic
 * palette metrics and asserts they match the committed Python baseline
 * `goldens/color-palette/py_results.json` within a tiny
 * float tolerance. This is the layer-2 (deterministic-scoring parity) golden
 * for the colour-palette suite — the same record→replay proof the calc `e2e/`
 * slice uses, extended to palettes; the LLM-scored valid/relevance/design
 * rubric is excluded (non-deterministic).
 *
 * Run `scripts/golden/replay_palettes_parity.ts` offline. See
 * `goldens/color-palette/README.md`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeMetric, type MetricContext } from "@tableau-ai-eval/evals";
import { REPO_ROOT } from "./golden_harness.ts";

const GOLDEN_DIR = join(REPO_ROOT, "goldens", "color-palette");
const TOL = 1e-6;

interface CaseResponse {
  id: string;
  paletteType: string | null;
  expected: { colorPalette?: string[] } | null;
  colors: string[] | null;
}
interface PyResult {
  id: string;
  metrics: Record<string, number | null>;
}

const PALETTE_METRICS = [
  "ColorPaletteDistinguishability",
  "GradientSmoothness",
  "DivergingPaletteStructure",
  "GroundTruthColorPaletteEvaluation",
];

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8")) as T;
}

function scoreCase(c: CaseResponse): Record<string, number | null> {
  const colors = Array.isArray(c.colors) ? c.colors : [];
  const expected = c.expected?.colorPalette ?? [];
  const out: Record<string, number | null> = {};
  for (const name of PALETTE_METRICS) {
    const ctx: MetricContext = { paletteType: c.paletteType ?? undefined, colors, expected, actual: colors };
    for (const cm of computeMetric(name, ctx)) out[cm.metric_name] = cm.score;
  }
  return out;
}

describe("colour-palette parity golden (TS vs Python, deterministic metrics)", () => {
  const cases = readJson<CaseResponse[]>("case_responses.json");
  const py = new Map(readJson<PyResult[]>("py_results.json").map((r) => [r.id, r]));

  test("the captured subset covers all three palette types", () => {
    const types = new Set(cases.map((c) => c.paletteType));
    expect([...types].sort()).toEqual(["diverging", "regular", "sequential"]);
  });

  test("every case scores identically to the Python baseline", () => {
    expect(cases.length).toBeGreaterThan(0);
    let comparisons = 0;
    for (const c of cases) {
      const ts = scoreCase(c);
      const baseline = py.get(c.id);
      expect(baseline, `Python baseline for ${c.id}`).toBeDefined();
      const names = new Set([...Object.keys(ts), ...Object.keys(baseline!.metrics)]);
      for (const name of names) {
        const tv = ts[name] ?? null;
        const pv = baseline!.metrics[name] ?? null;
        if (tv === null || pv === null) {
          expect(tv, `${c.id}.${name} presence`).toBe(pv);
        } else {
          expect(Math.abs(tv - pv), `${c.id}.${name} (ts=${tv}, py=${pv})`).toBeLessThanOrEqual(TOL);
        }
        comparisons++;
      }
    }
    // Guard against a silently-empty diff.
    expect(comparisons).toBeGreaterThanOrEqual(cases.length);
  });
});
