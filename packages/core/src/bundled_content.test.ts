import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_CONTENT_FILES,
  bundledContentRoot,
  mountContentPack,
  openEmbeddedContent,
  prepareBundledContent,
} from "./bundled_content.ts";
import {
  contentExists,
  contentIsDir,
  contentIsFile,
  contentReadBytes,
  contentReaddir,
  contentReadText,
  contentStamp,
} from "./content_fs.ts";
import { ContentPack, ContentPackWriter } from "./content_pack.ts";

const dirs: string[] = [];
afterEach(() => {
  mountContentPack(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const dictionary = Buffer.from('{"id":"x","inputs":[]}'.repeat(50));

function parts(files: Record<string, string>) {
  const w = new ContentPackWriter(dictionary);
  for (const [name, text] of Object.entries(files)) w.add(name, new TextEncoder().encode(text));
  return w.finish();
}

function mount(files: Record<string, string>): string {
  const root = join(tmpdir(), "tableau-ai-eval-mounted-<bundled>");
  mountContentPack(ContentPack.open(parts(files)), root);
  return root;
}

test("outside a compiled binary nothing is mounted: the checkout's plain files are used", async () => {
  expect(await prepareBundledContent()).toBe(null);
  expect(bundledContentRoot()).toBe(null);
});

test("paths under the mount are served from the pack", () => {
  const root = mount({
    "public-suites/calcs/cases/a.json": '{"id":"a"}',
    "public-suites/calcs/cases/b.json": '\uFEFF{"id":"b"}',
    "prep-bench/flows/p.json": "hi",
  });
  expect(bundledContentRoot()).toBe(root);
  expect(contentIsDir(root)).toBe(true);
  expect(contentReaddir(root)).toEqual(["prep-bench", "public-suites"]);
  expect(contentIsDir(join(root, "public-suites", "calcs"))).toBe(true);
  expect(contentIsFile(join(root, "public-suites", "calcs"))).toBe(false);
  expect(contentReaddir(join(root, "public-suites", "calcs", "cases"))).toEqual(["a.json", "b.json"]);
  expect(contentReadText(join(root, "public-suites", "calcs", "cases", "a.json"))).toBe('{"id":"a"}');
  expect(contentReadText(join(root, "public-suites", "calcs", "cases", "b.json"))).toBe('\uFEFF{"id":"b"}');
  expect(contentIsFile(join(root, "prep-bench", "flows", "p.json"))).toBe(true);
  expect(contentExists(join(root, "prep-bench", "flows"))).toBe(true);
  expect(contentExists(join(root, "nope"))).toBe(false);
  expect(contentStamp(join(root, "public-suites"))).toBe(0);
  expect(contentStamp(join(root, "nope"))).toBe(null);
  // Relative segments are normalized the way the filesystem would.
  expect(contentReadText(join(root, "public-suites", "calcs", "..", "calcs", "cases", "a.json"))).toBe('{"id":"a"}');
});

test("missing packed paths fail with filesystem error codes", () => {
  const root = mount({ "public-suites/a.json": "{}" });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as NodeJS.ErrnoException).code;
    }
    return "no error";
  };
  expect(code(() => contentReadText(join(root, "public-suites", "b.json")))).toBe("ENOENT");
  expect(code(() => contentReadBytes(join(root, "public-suites")))).toBe("EISDIR");
  expect(code(() => contentReaddir(join(root, "public-suites", "a.json")))).toBe("ENOTDIR");
  expect(code(() => contentReaddir(join(root, "nope")))).toBe("ENOENT");
});

test("paths outside the mount still use the real filesystem", () => {
  mount({ "public-suites/a.json": "{}" });
  const real = mkdtempSync(join(tmpdir(), "tableau-ai-eval-cfs-"));
  dirs.push(real);
  mkdirSync(join(real, "cases"));
  writeFileSync(join(real, "cases", "x.json"), '{"x":1}');
  expect(contentIsDir(join(real, "cases"))).toBe(true);
  expect(contentReaddir(join(real, "cases"))).toEqual(["x.json"]);
  expect(contentReadText(join(real, "cases", "x.json"))).toBe('{"x":1}');
  expect([...contentReadBytes(join(real, "cases", "x.json"))].length).toBe(7);
  expect(contentStamp(join(real, "cases"))).toBeGreaterThan(0);
  expect(contentIsFile(join(real, "nope"))).toBe(false);
});

test("openEmbeddedContent finds the parts by their hashed embedded names", async () => {
  const p = parts({ "public-suites/a.json": '{"a":1}' });
  const named = (name: string, bytes: Uint8Array) => Object.assign(new Blob([Uint8Array.from(bytes)]), { name });
  const pack = await openEmbeddedContent([
    named("tableau-ai-eval-content-index-ab12cd.zst", p.index),
    named("tableau-ai-eval-content-dictionary-ab12cd.zdict", p.dictionary),
    named("tableau-ai-eval-content-data-ab12cd.bin", p.data),
    named("index-abcd.html", new Uint8Array(1)),
  ]);
  expect(new TextDecoder().decode(pack!.read("public-suites/a.json")!)).toBe('{"a":1}');
  expect(await openEmbeddedContent([named("other.bin", new Uint8Array(1))])).toBe(null);
  await expect(
    openEmbeddedContent([named(BUNDLED_CONTENT_FILES.index, p.index), named(BUNDLED_CONTENT_FILES.data, p.data)]),
  ).rejects.toThrow(/incomplete \(missing dictionary\)/);
});
