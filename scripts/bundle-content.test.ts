import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentPack } from "../packages/core/src/content_pack.ts";
import { CONTENT_DICTIONARY, archiveName, listContent, packContent } from "./bundle-content.ts";

const REPO = join(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function staged(): string {
  const root = mkdtempSync(join(tmpdir(), "tableau-ai-eval-pack-"));
  dirs.push(root);
  mkdirSync(join(root, "public-suites", "calcs", "cases"), { recursive: true });
  writeFileSync(join(root, "public-suites", "calcs", "cases", "a.json"), "{}");
  writeFileSync(join(root, "public-suites", ".gitkeep"), "");
  mkdirSync(join(root, "extra-content"), { recursive: true });
  writeFileSync(join(root, "extra-content", ".git"), "gitdir: ../.git/modules/x");
  writeFileSync(join(root, "extra-content", "README.md"), "r");
  return root;
}

test("archiveName: always POSIX separators", () => {
  const root = join(tmpdir(), "r");
  expect(archiveName(root, join(root, "public-suites", "calcs", "a.json"))).toBe("public-suites/calcs/a.json");
});

test("listContent: skips .git, names are POSIX and sorted", () => {
  const root = staged();
  expect(listContent(root, ["public-suites", "extra-content"]).map((f) => f.name)).toEqual([
    "extra-content/README.md",
    "public-suites/.gitkeep",
    "public-suites/calcs/cases/a.json",
  ]);
});

test("packContent: the pack opens and reads back each file", () => {
  const root = staged();
  const p = packContent(root, Buffer.from("dictionary".repeat(50)), ["public-suites", "extra-content"]);
  expect(p.count).toBe(3);
  const pack = ContentPack.open(p);
  expect(new TextDecoder().decode(pack.read("public-suites/calcs/cases/a.json")!)).toBe("{}");
  expect(new TextDecoder().decode(pack.read("extra-content/README.md")!)).toBe("r");
});

test("default content pack ignores unrelated checkout folders", () => {
  const root = staged();
  mkdirSync(join(root, "prep-bench"), { recursive: true });
  expect(listContent(root).map((f) => f.name)).toEqual([
    "public-suites/.gitkeep",
    "public-suites/calcs/cases/a.json",
  ]);
});

test("the committed dictionary is present and usable", () => {
  const path = join(REPO, CONTENT_DICTIONARY);
  expect(existsSync(path)).toBe(true);
  const dict = readFileSync(path);
  // A trained zstd dictionary starts with the dictionary magic 0xEC30A437 (LE).
  expect(dict.readUInt32LE(0)).toBe(0xec30a437);
  const p = packContent(REPO, dict, ["prep-bench"]);
  const pack = ContentPack.open(p);
  for (const f of listContent(REPO, ["prep-bench"])) {
    expect(Buffer.from(pack.read(f.name)!).equals(readFileSync(f.path))).toBe(true);
  }
});
