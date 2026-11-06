/**
 * Prep calc checker, formula similarity, field-metadata parsing and intent
 * labels pinned by goldens/prep/expected_checker.json.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCalc, formulaSimilarity, parseFieldMetadata } from "./calc_checker.ts";
import { normalizeIntent } from "./intent.ts";

const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "goldens", "prep", "expected_checker.json"), "utf-8"),
);

describe("checkCalc matches the bench", () => {
  GOLDEN.checks.forEach(
    (c: { formula: string | null; fields?: string[] | null; field_metadata?: string; problems: string[] }, i: number) => {
      test(`${i}: ${JSON.stringify(c.formula)?.slice(0, 60)}`, () => {
        const fields =
          "field_metadata" in c
            ? parseFieldMetadata(c.field_metadata)
            : c.fields === null || c.fields === undefined
              ? null
              : new Set(c.fields);
        expect(checkCalc(c.formula, fields)).toEqual(c.problems);
      });
    },
  );
});

test("every expected formula of the shipped suite is valid", () => {
  const suite = GOLDEN.checks.filter((c: { field_metadata?: unknown }) => "field_metadata" in c);
  expect(suite.length).toBeGreaterThanOrEqual(40);
  expect(suite.filter((c: { problems: string[] }) => c.problems.length)).toEqual([]);
});

test("formulaSimilarity matches the bench", () => {
  for (const s of GOLDEN.similarity) {
    const [score, explanation] = formulaSimilarity(s.expected, s.actual);
    expect(score).toBeCloseTo(s.score, 12);
    expect(explanation).toBe(s.explanation);
  }
});

test("parseFieldMetadata matches the bench", () => {
  for (const m of GOLDEN.metadata) {
    const r = parseFieldMetadata(m.text);
    expect(r === null ? null : [...r].sort()).toEqual(m.fields);
  }
});

test("intent answers are read as labels", () => {
  for (const i of GOLDEN.intents) expect(normalizeIntent(i.answer)).toBe(i.label);
});
