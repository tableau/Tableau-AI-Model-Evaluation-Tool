/**
 * Every expected formula in the public Calculated fields suite is valid
 * Tableau for its dataset, by the evaluator's validator: a formula the
 * validator rejects would score every model answer against a broken
 * reference.
 * Uses the validator in `@tableau-ai-eval/evals`.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { TableauValidator } from "@tableau-ai-eval/evals";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const SUITES = join(REPO, "public-suites");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".json") ? [p] : [];
  });
}

function fixtures(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(join(SUITES, "fixtures")).filter((n) => n.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(SUITES, "fixtures", f), "utf-8"));
    out[basename(f, ".json")] = Object.fromEntries(
      (data.fields as { caption: string; datatype?: string }[]).map((x) => [x.caption, x.datatype ?? ""]),
    );
  }
  return out;
}

test("every expected calc formula is valid Tableau", () => {
  const fx = fixtures();
  const rejected: [string, string, string[]][] = [];
  let checked = 0;
  for (const f of walk(join(SUITES, "calcs", "cases")).sort()) {
    const data = JSON.parse(readFileSync(f, "utf-8"));
    for (const c of Array.isArray(data) ? data : [data]) {
      const columns = fx[c.datasource] ?? {};
      for (const turn of c.inputs ?? [c]) {
        const formula = turn.expected?.calculatedFieldFormula?.formula;
        if (!formula) continue;
        checked += 1;
        const { isValid, errors } = new TableauValidator(columns).validate(formula);
        if (!isValid) rejected.push([basename(f), formula, errors]);
      }
    }
  }
  expect(checked).toBeGreaterThanOrEqual(160);
  expect(rejected).toEqual([]);
});
