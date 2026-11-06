import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groundTruthFor } from "./cabu_runner.ts";

const isFile = (p: string) => existsSync(p);
const read = (p: string) => readFileSync(p, "utf-8");

test("a suite's ground truth is read from the sibling ground-truth folder, keyed by case id", () => {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  mkdirSync(join(root, "cases"));
  mkdirSync(join(root, "ground-truth"));
  const suite = join(root, "cases", "cabu_public_demo.yml");
  writeFileSync(suite, "tests: []\n");
  writeFileSync(join(root, "ground-truth", "cabu_public_demo.json"), JSON.stringify({
    suite_file: "cabu_public_demo.yml",
    cases: [
      { id: "a.1", kind: "data", datasource: "claims", sql: "SELECT SUM(x) FROM t", render: { kind: "money" }, expect: "$5" },
      { id: "a.2", kind: "clarify", datasource: "claims", expect: null },
    ],
  }));
  const truths = groundTruthFor(suite, isFile, read);
  expect(truths.get("a.1")).toEqual({ datasource: "claims", sql: "SELECT SUM(x) FROM t", expect: "$5", kind: "data" });
  expect(truths.get("a.2")).toEqual({ datasource: "claims", expect: null, kind: "clarify" });
  expect(truths.has("a.3")).toBe(false);
});

test("no ground-truth file means no entries, not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  mkdirSync(join(root, "cases"));
  expect(groundTruthFor(join(root, "cases", "x.yml"), isFile, read).size).toBe(0);
});
