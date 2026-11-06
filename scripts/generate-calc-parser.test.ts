import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCalcParser } from "./generate-calc-parser.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = "packages/evals/src/validator";

test("checked-in calculation parser is fresh", async () => {
  expect(await generateCalcParser({ check: true })).toBe(false);
});

test("generation is deterministic, skips fresh output, and detects grammar/output changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tableau-ai-eval-calc-cache-test-"));
  try {
    const grammar = join(root, BASE, "grammar/TableauCalculationGrammar.g4");
    mkdirSync(dirname(grammar), { recursive: true });
    copyFileSync(join(ROOT, BASE, "grammar/TableauCalculationGrammar.g4"), grammar);
    expect(await generateCalcParser({ root })).toBe(true);
    const output = join(root, BASE, "generated/TableauCalculationGrammarParser.ts");
    const first = readFileSync(output, "utf8");
    expect(first).toBe(readFileSync(join(ROOT, BASE, "generated/TableauCalculationGrammarParser.ts"), "utf8"));
    expect(await generateCalcParser({ root })).toBe(false);
    expect(await generateCalcParser({ root, force: true })).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(first);
    writeFileSync(output, first + "// modified\n");
    await expect(generateCalcParser({ root, check: true })).rejects.toThrow("cache is stale");
    expect(await generateCalcParser({ root })).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(first);
    // A real grammar change must affect the generated lexer, not just the manifest.
    writeFileSync(grammar, readFileSync(grammar, "utf8").replace("PLUS : '+';", "PLUS : '+' | '⊕';"));
    await expect(generateCalcParser({ root, check: true })).rejects.toThrow("cache is stale");
    expect(await generateCalcParser({ root })).toBe(true);
    expect(readFileSync(join(root, BASE, "generated/TableauCalculationGrammarLexer.ts"), "utf8"))
      .not.toBe(readFileSync(join(ROOT, BASE, "generated/TableauCalculationGrammarLexer.ts"), "utf8"));
    expect(await generateCalcParser({ root, check: true })).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
