import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrepParser } from "./generate-prep-parser.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = "packages/evals/src/prep";

test("checked-in Prep parser is fresh", async () => {
  expect(await generatePrepParser({ check: true })).toBe(false);
});

test("Prep generation is deterministic, skips fresh output, and detects grammar/output changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tableau-ai-eval-prep-cache-test-"));
  try {
    const grammar = join(root, BASE, "grammar/TableauExpression.g4");
    mkdirSync(dirname(grammar), { recursive: true });
    copyFileSync(join(ROOT, BASE, "grammar/TableauExpression.g4"), grammar);
    expect(await generatePrepParser({ root })).toBe(true);
    const output = join(root, BASE, "generated/TableauExpressionParser.ts");
    const lexer = join(root, BASE, "generated/TableauExpressionLexer.ts");
    const first = readFileSync(output, "utf8");
    expect(first).toBe(readFileSync(join(ROOT, BASE, "generated/TableauExpressionParser.ts"), "utf8"));
    expect(await generatePrepParser({ root })).toBe(false);
    expect(await generatePrepParser({ root, force: true })).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(first);
    writeFileSync(output, first + "// modified\n");
    await expect(generatePrepParser({ root, check: true })).rejects.toThrow("cache is stale");
    expect(await generatePrepParser({ root })).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(first);
    rmSync(lexer);
    await expect(generatePrepParser({ root, check: true })).rejects.toThrow("cache is stale");
    expect(await generatePrepParser({ root })).toBe(true);
    // A real grammar change must affect the generated lexer, not just the manifest.
    writeFileSync(grammar, readFileSync(grammar, "utf8").replace("PLUS : '+';", "PLUS : '+' | '⊕';"));
    await expect(generatePrepParser({ root, check: true })).rejects.toThrow("cache is stale");
    expect(await generatePrepParser({ root })).toBe(true);
    expect(readFileSync(lexer, "utf8"))
      .not.toBe(readFileSync(join(ROOT, BASE, "generated/TableauExpressionLexer.ts"), "utf8"));
    expect(await generatePrepParser({ root, check: true })).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
