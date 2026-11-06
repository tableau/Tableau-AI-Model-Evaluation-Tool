/**
 * Context-metric golden PARITY test (offline, deterministic).
 *
 * Loads goldens/context_metrics/inputs.json (synthetic _context fixtures) and
 * goldens/context_metrics/expected.json (scores produced by the reference
 * context metric classes SemanticSearchAccuracy / SpecSemanticSearchAccuracy /
 * FieldRankScorer reference fixtures and ranx 0.3.21),
 * runs the SAME inputs through the TypeScript compute functions in
 * src/metrics/classes.ts (+ the calc parser in src/harness/nlq_runner.ts, which
 * mirrors ParseCalcsFormula), and asserts parity with the golden.
 *
 * This is an AUDIT. hit_rate/proportions are exact rationals; only a tiny float
 * epsilon absorbs IEEE repr of e.g. 1/3, 1/6. Any REAL divergence fails loudly
 * with the case name + both values so the port bug is caught, not hidden.
 *
 * The wiring here mirrors NlqHarnessRunner.computeStageMetric:
 *   - SemanticSearchAccuracy / FieldRankScorer are key="formula": the fixture
 *     calc formula is parsed into parsedExpectedFields (parseCalcsFormula).
 *   - SpecSemanticSearchAccuracy has no key: its expected is the notionalSpec
 *     object, read via find_sub_entries(["field","caption"]).
 *   - All three read semanticsearchResults (the _context matched list).
 *
 * KNOWN DIVERGENCE captured explicitly (see rank_chunk_all_filtered_empty_run):
 *   When EVERY chunk's run dict is empty (all matches filtered), ranx.Run raises
 *   "max() arg is an empty sequence" and the reference FieldRankScorer PROPAGATES it
 *   (the len(run)==0 guard does not fire — len is 1). The TS evaluateMulti
 *   instead treats the empty chunk as a 0-scoring query, so TS returns all-0
 *   metrics. We assert the TS behavior directly and do NOT pretend a reference
 *   value exists. See dossier .agent-dossiers/context_metrics.md.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeSemanticSearchAccuracy,
  computeSpecSemanticSearchAccuracy,
  computeFieldRankScorer,
  type ComputedMetric,
  type MetricContext,
} from "./classes.ts";
import { parseCalcsFormula } from "../harness/nlq_runner.ts";

const DIR = join(import.meta.dir, "..", "..", "..", "..", "goldens", "context_metrics");

interface GoldenMetric {
  metric_name: string;
  score: number;
  explanation: unknown;
}
interface GoldenCase {
  name: string;
  metric_class: string;
  metrics: GoldenMetric[] | null;
  python_error?: string;
}

const inputs = JSON.parse(readFileSync(join(DIR, "inputs.json"), "utf-8"));
const expected = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf-8")) as {
  cases: GoldenCase[];
};

/** Exact for 0/1; tiny epsilon absorbs IEEE repr of exact rationals (1/3, 1/6). */
const EPS = 1e-12;

function golden(name: string): GoldenCase {
  const c = expected.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no golden case named ${name} in expected.json`);
  return c;
}

/** Assert TS-computed metrics match the golden exactly (name + score). */
function assertParity(caseName: string, tsMetrics: ComputedMetric[]): void {
  const g = golden(caseName);
  const gm = g.metrics ?? [];
  expect(
    tsMetrics.length,
    `[${caseName}] metric COUNT diverges: TS=${tsMetrics.length} golden=${gm.length}\n` +
      `  TS: ${JSON.stringify(tsMetrics.map((m) => [m.metric_name, m.score]))}\n` +
      `  PY: ${JSON.stringify(gm.map((m) => [m.metric_name, m.score]))}`,
  ).toBe(gm.length);

  for (const g0 of gm) {
    const tm = tsMetrics.find((m) => m.metric_name === g0.metric_name);
    expect(
      tm,
      `[${caseName}] The golden has metric_name="${g0.metric_name}" but TS did not.\n` +
        `  TS names: ${JSON.stringify(tsMetrics.map((m) => m.metric_name))}`,
    ).toBeDefined();
    const diff = Math.abs((tm as ComputedMetric).score - g0.score);
    expect(
      diff <= EPS,
      `[${caseName}] SCORE DIVERGENCE on "${g0.metric_name}": ` +
        `TS=${(tm as ComputedMetric).score} golden=${g0.score} (|Δ|=${diff})`,
    ).toBe(true);
  }
  for (const tm of tsMetrics) {
    const g0 = gm.find((m) => m.metric_name === tm.metric_name);
    expect(
      g0,
      `[${caseName}] TS emitted extra metric_name="${tm.metric_name}" (score ${tm.score}) ` +
        `not present in the golden.`,
    ).toBeDefined();
  }
}

// ---------------------------------------------------------------------------
// SemanticSearchAccuracy (key="formula" -> parsedExpectedFields)
// ---------------------------------------------------------------------------

describe("golden parity — SemanticSearchAccuracy", () => {
  for (const c of inputs.semantic_search_accuracy_cases) {
    test(c.name, () => {
      const pe = parseCalcsFormula(c.expected_formula);
      const ctx: MetricContext = {
        utterance: c.utterance,
        parsedExpectedFields: pe.fields,
        semanticsearchResults: c.semanticsearch_results,
      };
      assertParity(c.name, computeSemanticSearchAccuracy(ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// SpecSemanticSearchAccuracy (no key -> expected = notionalSpec)
// ---------------------------------------------------------------------------

describe("golden parity — SpecSemanticSearchAccuracy", () => {
  for (const c of inputs.spec_semantic_search_accuracy_cases) {
    test(c.name, () => {
      const ctx: MetricContext = {
        utterance: c.utterance,
        expected: c.notional_spec,
        semanticsearchResults: c.semanticsearch_results,
      };
      assertParity(c.name, computeSpecSemanticSearchAccuracy(ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// FieldRankScorer (key="formula" -> parsedExpectedFields; ranx per chunk)
// ---------------------------------------------------------------------------

describe("golden parity — FieldRankScorer", () => {
  for (const c of inputs.field_rank_scorer_cases) {
    const g = golden(c.name);
    if (g.python_error) {
      // KNOWN DIVERGENCE: Python raises (ranx.Run on an all-empty run). Assert
      // the TS behavior directly rather than a nonexistent reference value.
      test(`${c.name} (reference errors: ${g.python_error} — asserting TS divergence)`, () => {
        const pe = parseCalcsFormula(c.expected_formula);
        const ctx: MetricContext = {
          utterance: c.utterance,
          parsedExpectedFields: pe.fields,
          semanticsearchResults: c.semanticsearch_results,
        };
        const ts = computeFieldRankScorer(ctx);
        // TS does not throw: it returns all-0 metrics for the single empty chunk
        // (empty run query scores 0 under make_comparable semantics in ir.ts).
        expect(ts.length).toBe(5);
        for (const m of ts) expect(m.score).toBe(0);
      });
      continue;
    }
    test(c.name, () => {
      const pe = parseCalcsFormula(c.expected_formula);
      const ctx: MetricContext = {
        utterance: c.utterance,
        parsedExpectedFields: pe.fields,
        semanticsearchResults: c.semanticsearch_results,
      };
      assertParity(c.name, computeFieldRankScorer(ctx));
    });
  }
});
