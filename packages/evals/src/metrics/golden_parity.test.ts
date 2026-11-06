/**
 * Metric micro-golden PARITY test (offline, deterministic).
 *
 * Loads goldens/metrics/inputs.json (hand-built expected/actual fixture pairs)
 * and goldens/metrics/expected.json (scores produced by the reference metric
 * classes captured in goldens/metrics/expected.json),
 * runs the SAME inputs through the TypeScript computeMetric registry
 * (src/metrics/classes.ts) + calc parser (src/harness/nlq_runner.ts), and
 * asserts the TS scores match the golden.
 *
 * This is an AUDIT: booleans/equals and precision/recall are compared exactly
 * (they are exact rationals here — 0, 0.5, 1, 2/3), with only a tiny float
 * epsilon to absorb IEEE representation of e.g. 2/3. Any real divergence fails
 * loudly with the case name + both values so the port bug is caught, NOT hidden.
 *
 * The metric dispatch here MIRRORS how NlqHarnessRunner.computeStageMetric wires
 * each class: calc metrics parse the formula string into fields/values first
 * (parseCalcsFormula), spec metrics read fields via find_sub_entries, and the
 * validity metrics receive the datasource fields declared inline in inputs.json.
 *
 * Explanations are NOT compared: the reference validator emits ANTLR-specific error
 * strings that legitimately differ from the TS validator. Only SCORES are the
 * faithfulness contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeEquals,
  computeSpecFieldAccuracy,
  computeSpecFieldValidity,
  computeCalcValidity,
  computeCalcFieldValidity,
  computeCalcFieldAccuracy,
  computeCalcValueAccuracy,
  type ComputedMetric,
  type MetricContext,
} from "./classes.ts";
import { parseCalcsFormula } from "../harness/nlq_runner.ts";

const METRICS_DIR = join(import.meta.dir, "..", "..", "..", "..", "goldens", "metrics");

interface GoldenMetric {
  metric_name: string;
  score: number;
  explanation: unknown;
}
interface GoldenCase {
  name: string;
  metric_class: string;
  metrics: GoldenMetric[];
}

const inputs = JSON.parse(readFileSync(join(METRICS_DIR, "inputs.json"), "utf-8"));
const expected = JSON.parse(readFileSync(join(METRICS_DIR, "expected.json"), "utf-8")) as {
  cases: GoldenCase[];
};

/** Exact for 0/1; small epsilon absorbs IEEE repr of exact rationals (e.g. 2/3). */
const EPS = 1e-12;

/** datasource id -> caption/datatype fields (mirrors get_datasource fixture). */
function datasourceFields(dsId: string): { caption: string; datatype?: string }[] {
  const ds = inputs.datasources[dsId];
  if (!ds || !Array.isArray(ds.fields)) return [];
  return ds.fields.map((f: { caption: string; datatype?: string }) => ({
    caption: f.caption,
    datatype: f.datatype,
  }));
}

function golden(name: string): GoldenCase {
  const c = expected.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no golden case named ${name} in expected.json`);
  return c;
}

/**
 * Assert the TS-computed metrics match the golden EXACTLY (score+name).
 * Fails loudly with the divergent values, per the audit principle.
 */
function assertParity(caseName: string, tsMetrics: ComputedMetric[]): void {
  const g = golden(caseName);
  // Same number of emitted metrics.
  expect(
    tsMetrics.length,
    `[${caseName}] metric COUNT diverges: TS=${tsMetrics.length} golden=${g.metrics.length}\n` +
      `  TS: ${JSON.stringify(tsMetrics.map((m) => [m.metric_name, m.score]))}\n` +
      `  PY: ${JSON.stringify(g.metrics.map((m) => [m.metric_name, m.score]))}`,
  ).toBe(g.metrics.length);

  // Match by metric_name (order should also agree, but match by name to give a
  // precise divergence message).
  for (const gm of g.metrics) {
    const tm = tsMetrics.find((m) => m.metric_name === gm.metric_name);
    expect(
      tm,
      `[${caseName}] The golden has metric_name="${gm.metric_name}" but TS did not.\n` +
        `  TS names: ${JSON.stringify(tsMetrics.map((m) => m.metric_name))}`,
    ).toBeDefined();
    const diff = Math.abs((tm as ComputedMetric).score - gm.score);
    expect(
      diff <= EPS,
      `[${caseName}] SCORE DIVERGENCE on "${gm.metric_name}": ` +
        `TS=${(tm as ComputedMetric).score} golden=${gm.score} (|Δ|=${diff})`,
    ).toBe(true);
  }
  // And no EXTRA metrics on the TS side.
  for (const tm of tsMetrics) {
    const gm = g.metrics.find((m) => m.metric_name === tm.metric_name);
    expect(
      gm,
      `[${caseName}] TS emitted extra metric_name="${tm.metric_name}" (score ${tm.score}) ` +
        `not present in the golden.`,
    ).toBeDefined();
  }
}

// ---------------------------------------------------------------------------
// Equals
// ---------------------------------------------------------------------------

describe("golden parity — Equals", () => {
  for (const c of inputs.equals_cases) {
    test(c.name, () => {
      const ctx: MetricContext = {
        utterance: c.utterance,
        expected: c.expected,
        actual: c.actual,
      };
      assertParity(c.name, computeEquals(ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// CalcValidity (validates the actual formula string against datasource fields)
// ---------------------------------------------------------------------------

describe("golden parity — CalcValidity", () => {
  for (const c of inputs.calc_validity_cases) {
    test(c.name, () => {
      const ctx: MetricContext = {
        utterance: c.utterance,
        // The harness passes the formula string as `actual` for CalcValidity.
        actual: c.actual_formula,
        datasourceFields: datasourceFields(c.datasource),
      };
      assertParity(c.name, computeCalcValidity(ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// CalcFieldValidity (precision of parsed actual calc fields vs datasource)
// ---------------------------------------------------------------------------

describe("golden parity — CalcFieldValidity", () => {
  for (const c of inputs.calc_field_validity_cases) {
    test(c.name, () => {
      const pa = parseCalcsFormula(c.actual_formula);
      const ctx: MetricContext = {
        utterance: c.utterance,
        parsedActualFields: pa.fields,
        datasourceFields: datasourceFields(c.datasource),
      };
      assertParity(c.name, computeCalcFieldValidity(ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// CalcFieldAccuracy (precision/recall over parsed calc fields)
// ---------------------------------------------------------------------------

describe("golden parity — CalcFieldAccuracy", () => {
  for (const c of inputs.calc_field_accuracy_cases) {
    test(c.name, () => {
      const pe = parseCalcsFormula(c.expected_formula);
      const pa = parseCalcsFormula(c.actual_formula);
      const ctx: MetricContext = {
        utterance: c.utterance,
        parsedExpectedFields: pe.fields,
        parsedActualFields: pa.fields,
      };
      assertParity(c.name, computeCalcFieldAccuracy(ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// CalcValueAccuracy (precision/recall over parsed calc string literals)
// ---------------------------------------------------------------------------

describe("golden parity — CalcValueAccuracy", () => {
  for (const c of inputs.calc_value_accuracy_cases) {
    test(c.name, () => {
      const pe = parseCalcsFormula(c.expected_formula);
      const pa = parseCalcsFormula(c.actual_formula);
      const ctx: MetricContext = {
        utterance: c.utterance,
        parsedExpectedValues: pe.values,
        parsedActualValues: pa.values,
        expectedValueText: pe.valueText,
        actualValueText: pa.valueText,
      };
      const ts = computeCalcValueAccuracy(ctx);
      assertParity(c.name, ts);
      // Explanations are deterministic text.
      expect(ts.map((m) => m.explanation ?? null)).toEqual(
        golden(c.name).metrics.map((m) => (m as { explanation?: string | null }).explanation ?? null),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// SpecFieldValidity (precision of actual spec fields vs datasource)
// ---------------------------------------------------------------------------

describe("golden parity — SpecFieldValidity", () => {
  for (const c of inputs.spec_field_validity_cases) {
    test(c.name, () => {
      const ctx: MetricContext = {
        utterance: c.utterance,
        actual: c.actual,
        datasourceFields: datasourceFields(c.datasource),
      };
      assertParity(c.name, computeSpecFieldValidity(ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// SpecFieldAccuracy (precision/recall over spec field captions)
// ---------------------------------------------------------------------------

describe("golden parity — SpecFieldAccuracy", () => {
  for (const c of inputs.spec_field_accuracy_cases) {
    test(c.name, () => {
      const ctx: MetricContext = {
        utterance: c.utterance,
        expected: c.expected,
        actual: c.actual,
      };
      assertParity(c.name, computeSpecFieldAccuracy(ctx));
    });
  }
});
