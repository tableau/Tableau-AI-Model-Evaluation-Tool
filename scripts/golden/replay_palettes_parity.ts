/**
 * OFFLINE parity diff for the colour-palette golden (goldens/color-palette/).
 *
 * Re-scores the identical recorded palette colors from `case_responses.json`
 * through the TS deterministic palette metrics (the SAME registry the runner
 * uses), and diffs against the Python baseline `py_results.json`
 * offline. The LLM-scored valid/relevance/design rubric
 * is excluded on both sides (non-deterministic).
 *
 * Writes `parity_report.json` and prints a summary; exits non-zero on any
 * metric divergence beyond a tiny float tolerance.
 *
 * Run (offline, repeatable):
 *   $HOME/.bun/bin/bun run scripts/golden/replay_palettes_parity.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeMetric, type MetricContext } from "@tableau-ai-eval/evals";
import { REPO_ROOT } from "./golden_harness.ts";

const GOLDEN_DIR = join(REPO_ROOT, "goldens", "color-palette");

// Float tolerance: CIEDE2000 is the same math both sides, but Python/JS differ
// in the last ULPs; 1e-6 is comfortably tighter than any real divergence.
const TOL = 1e-6;

interface CaseResponse {
  id: string;
  utterance: string;
  paletteType: string | null;
  expected: { colorPalette?: string[] } | null;
  colors: string[] | null;
}

interface PyResult {
  id: string;
  paletteType: string | null;
  colors_len: number;
  metrics: Record<string, number | null>;
}

/** The four deterministic palette metrics, keyed by class name → the ctx they need. */
const PALETTE_METRICS = [
  "ColorPaletteDistinguishability",
  "GradientSmoothness",
  "DivergingPaletteStructure",
  "GroundTruthColorPaletteEvaluation",
] as const;

/** Score one case's colors through the TS palette metrics (metric_name → score). */
function scoreCase(c: CaseResponse): Record<string, number | null> {
  const colors = Array.isArray(c.colors) ? c.colors : [];
  const expectedColors = c.expected?.colorPalette ?? [];
  const out: Record<string, number | null> = {};
  for (const name of PALETTE_METRICS) {
    const ctx: MetricContext = {
      paletteType: c.paletteType ?? undefined,
      colors,
      expected: expectedColors,
      actual: colors,
    };
    for (const cm of computeMetric(name, ctx)) {
      out[cm.metric_name] = cm.score;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const caseResponses = JSON.parse(
    await readFile(join(GOLDEN_DIR, "case_responses.json"), "utf8"),
  ) as CaseResponse[];
  const pyResults = JSON.parse(
    await readFile(join(GOLDEN_DIR, "py_results.json"), "utf8"),
  ) as PyResult[];
  const pyById = new Map(pyResults.map((r) => [r.id, r]));

  const report: Array<Record<string, unknown>> = [];
  let comparisons = 0;
  let divergences = 0;

  for (const c of caseResponses) {
    const ts = scoreCase(c);
    const py = pyById.get(c.id);
    if (!py) {
      report.push({ id: c.id, error: "no Python result for this case" });
      divergences++;
      continue;
    }
    // Union of metric names produced on either side.
    const names = new Set([...Object.keys(ts), ...Object.keys(py.metrics)]);
    const perMetric: Record<string, { ts: number | null; py: number | null; ok: boolean }> = {};
    for (const name of names) {
      const tv = ts[name] ?? null;
      const pv = py.metrics[name] ?? null;
      const ok =
        tv === null && pv === null
          ? true
          : tv !== null && pv !== null && Math.abs(tv - pv) <= TOL;
      perMetric[name] = { ts: tv, py: pv, ok };
      comparisons++;
      if (!ok) divergences++;
    }
    report.push({ id: c.id, paletteType: c.paletteType, metrics: perMetric });
  }

  const summary = {
    cases: caseResponses.length,
    metric_comparisons: comparisons,
    divergences,
    tolerance: TOL,
  };
  await writeFile(
    join(GOLDEN_DIR, "parity_report.json"),
    JSON.stringify({ summary, cases: report }, null, 2) + "\n",
    "utf8",
  );

  console.log("=== colour-palette parity (TS vs Python, deterministic metrics) ===");
  for (const c of report) {
    const metrics = c.metrics as Record<string, { ts: number | null; py: number | null; ok: boolean }> | undefined;
    if (!metrics) {
      console.log(`  ${c.id}: ${c.error}`);
      continue;
    }
    const parts = Object.entries(metrics).map(
      ([n, v]) => `${v.ok ? "✓" : "✗"} ${n}(ts=${v.ts}, py=${v.py})`,
    );
    console.log(`  [${c.paletteType}] ${String(c.id).slice(0, 8)}: ${parts.join(", ")}`);
  }
  console.log(
    `\n${summary.cases} cases, ${summary.metric_comparisons} metric comparisons, ${summary.divergences} divergence(s).`,
  );
  if (divergences > 0) {
    console.error("PARITY FAILED");
    process.exit(1);
  }
  console.log("PARITY OK — full Python↔TS agreement on the deterministic palette metrics.");
}

await main();
