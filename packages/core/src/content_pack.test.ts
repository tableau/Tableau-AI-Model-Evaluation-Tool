import { expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { ContentPack, ContentPackWriter, dictionaryId, isAlreadyCompressed } from "./content_pack.ts";

const dictionary = Buffer.from('{"id":"case","runner":"nlq","inputs":[{"utterance":"show sales by region"}]}'.repeat(40));
const enc = (s: string) => new TextEncoder().encode(s);
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6]);

function sample() {
  const w = new ContentPackWriter(dictionary);
  w.add("public-suites/calcs/cases/a.json", enc('{"id":"case","runner":"nlq","inputs":[]}'.repeat(30)));
  w.add("public-suites/calcs/fixtures/f.json", enc("{}"));
  w.add("public-suites/dashboard-qa/content/d.tdsx", zip);
  w.add("prep-bench/empty.txt", new Uint8Array(0));
  return w.finish();
}

test("round-trips every entry byte for byte", () => {
  const pack = ContentPack.open(sample());
  expect(pack.fileCount).toBe(4);
  expect(new TextDecoder().decode(pack.read("public-suites/calcs/cases/a.json")!)).toBe(
    '{"id":"case","runner":"nlq","inputs":[]}'.repeat(30),
  );
  expect(new TextDecoder().decode(pack.read("public-suites/calcs/fixtures/f.json")!)).toBe("{}");
  expect([...pack.read("public-suites/dashboard-qa/content/d.tdsx")!]).toEqual([...zip]);
  expect(pack.read("prep-bench/empty.txt")!.length).toBe(0);
  expect(pack.read("nope")).toBe(null);
  expect(pack.size("public-suites/calcs/cases/a.json")).toBe(1200);
});

test("text is compressed with the dictionary; ZIP payloads are stored as-is", () => {
  const parts = sample();
  // 1200-byte JSON shrinks well below its size; the ZIP is copied verbatim.
  expect(parts.data.length).toBeLessThan(200);
  const at = Buffer.from(parts.data).indexOf(Buffer.from(zip));
  expect(at).toBeGreaterThanOrEqual(0);
});

test("reads return independent buffers", () => {
  const pack = ContentPack.open(sample());
  const a = pack.read("public-suites/dashboard-qa/content/d.tdsx")!;
  a[0] = 0;
  expect(pack.read("public-suites/dashboard-qa/content/d.tdsx")![0]).toBe(0x50);
});

test("directories are implied by names", () => {
  const pack = ContentPack.open(sample());
  expect(pack.list("")).toEqual(["prep-bench", "public-suites"]);
  expect(pack.list("public-suites")).toEqual(["calcs", "dashboard-qa"]);
  expect(pack.list("public-suites/calcs")).toEqual(["cases", "fixtures"]);
  expect(pack.isDir("public-suites/calcs")).toBe(true);
  expect(pack.isFile("public-suites/calcs")).toBe(false);
  expect(pack.list("public-suites/calcs/cases/a.json")).toBe(null);
  expect(pack.list("missing")).toBe(null);
});

test("writer refuses unsafe and duplicate names", () => {
  const w = new ContentPackWriter(dictionary);
  for (const bad of ["../x", "/abs", "a//b", "a/./b", "C:/x", "a\\b", ""]) {
    expect(() => w.add(bad, enc("x"))).toThrow(/unsafe/);
  }
  w.add("a/b", enc("x"));
  expect(() => w.add("a/b", enc("y"))).toThrow(/duplicate/);
});

test("open rejects a mismatched dictionary, truncated data, or a bad index", () => {
  const parts = sample();
  expect(() => ContentPack.open({ ...parts, dictionary: Buffer.from("other") })).toThrow(/dictionary/);
  expect(() => ContentPack.open({ ...parts, data: parts.data.subarray(1) })).toThrow(/data/);
  expect(() => ContentPack.open({ ...parts, index: new Uint8Array([1, 2, 3]) })).toThrow(/unreadable/);
  const doc = (entries: unknown[], version = 1) =>
    zstdCompressSync(
      Buffer.from(JSON.stringify({ version, dictionary: dictionaryId(dictionary), data: 4, entries })),
    );
  const data = new Uint8Array(4);
  expect(() => ContentPack.open({ index: doc([], 2), dictionary, data })).toThrow(/version/);
  expect(() => ContentPack.open({ index: doc([["../x", 0, 1, 1, 0]]), dictionary, data })).toThrow(/bad/);
  expect(() => ContentPack.open({ index: doc([["a", 2, 4, 4, 0]]), dictionary, data })).toThrow(/outside/);
  expect(() => ContentPack.open({ index: doc([["a", 0, 1, 1, 7]]), dictionary, data })).toThrow(/codec/);
  expect(() =>
    ContentPack.open({ index: doc([["a", 0, 1, 1, 0], ["a/b", 1, 1, 1, 0]]), dictionary, data }),
  ).toThrow(/both a file and a directory/);
});

test("a corrupted frame is reported, not returned", () => {
  const parts = sample();
  const data = Uint8Array.from(parts.data);
  data[10] ^= 0xff;
  const pack = ContentPack.open({ ...parts, data });
  expect(() => pack.read("public-suites/calcs/cases/a.json")).toThrow(/corrupt/);
});

test("isAlreadyCompressed recognizes ZIP, gzip, zstd, PNG and JPEG", () => {
  expect(isAlreadyCompressed(zip)).toBe(true);
  expect(isAlreadyCompressed(new Uint8Array([0x1f, 0x8b]))).toBe(true);
  expect(isAlreadyCompressed(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe(true);
  expect(isAlreadyCompressed(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  expect(isAlreadyCompressed(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(true);
  expect(isAlreadyCompressed(enc('{"a":1}'))).toBe(false);
  expect(isAlreadyCompressed(new Uint8Array(0))).toBe(false);
});
