/**
 * Calculation literal-value accuracy regression tests:
 * valuePrecision / valueRecall on the literal values of two formulas.
 */
import { expect, test } from "bun:test";
import { parseCalcsFormula } from "../harness/nlq_runner.ts";
import { computeCalcValueAccuracy } from "./classes.ts";

function score(expected: string, actual: string): Record<string, [number, string | null | undefined]> {
  const pe = parseCalcsFormula(expected);
  const pa = parseCalcsFormula(actual);
  const out: Record<string, [number, string | null | undefined]> = {};
  for (const m of computeCalcValueAccuracy({
    utterance: "q",
    parsedExpectedValues: pe.values,
    parsedActualValues: pa.values,
    expectedValueText: pe.valueText,
    actualValueText: pa.valueText,
  })) {
    out[m.metric_name] = [m.score, m.explanation];
  }
  return out;
}

test("numbers and text count and match by value", () => {
  const out = score(
    "IF [Amount] > 0.9 THEN 'High' ELSE 'Low' END",
    "IF [Amount] > 0.90 THEN 'high' ELSE 'Low' END",
  );
  expect(out.valuePrecision![0]).toBe(1.0);
  expect(out.valueRecall![0]).toBe(1.0);
  expect(out.valuePrecision![1]).toBe(
    "Matched 3 of 3 expected values. 'high' counts as 'High' (only the case differs; Tableau itself is case-sensitive).",
  );
});

test("date parts are not values", () => {
  expect(score("DATEPART('day', [Date])", "DAY([Date])")).toEqual({});
});

test("missing and extra values are named", () => {
  const out = score("CONTAINS([Type], 'social')", "IF CONTAINS([Type], 'task') THEN 1 ELSE 0 END");
  expect(out.valuePrecision![0]).toBe(0.0);
  expect(out.valueRecall![0]).toBe(0.0);
  expect(out.valuePrecision![1]).toBe(
    "Matched 0 of 1 expected values (missing: 'social'; extra: 0, 1, 'task').",
  );
});

test("extra values count against precision when none were expected", () => {
  const out = score("[Profit] / [Sales]", "IF [Sales] > 100 THEN [Profit] / [Sales] END");
  expect(Object.keys(out)).toEqual(["valuePrecision"]);
  expect(out.valuePrecision).toEqual([0.0, "The expected formula has no literal values; the answer adds 100."]);
});

test("an empty answer scores zero on both", () => {
  const out = score("[Sales] * 2", "");
  expect(out.valuePrecision![0]).toBe(0.0);
  expect(out.valueRecall![0]).toBe(0.0);
});

test("no expected formula means no value metrics", () => {
  expect(computeCalcValueAccuracy({ parsedActualValues: ["n:1"] })).toEqual([]);
});
