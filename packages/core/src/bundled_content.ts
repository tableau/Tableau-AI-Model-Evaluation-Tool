/**
 * Test content embedded in the compiled binary.
 *
 * `bun release` packs `public-suites/`, `prep-bench/` and (when checked out)
 * into an indexed content pack (`content_pack.ts`) and
 * embeds its three parts in the `tableau-ai-eval` executable (`Bun.embeddedFiles`), so
 * the release ships as two executables only (`tableau-ai-eval` + `hyperd`).
 *
 * At start-up the binary opens the pack in memory: the index is decoded, the
 * file data stays compressed, and each file is decompressed only when it is
 * read. Nothing is written to disk. The pack is mounted under a virtual
 * directory, {@link bundledContentRoot}, that the suite resolvers use as their
 * content root; `content_fs.ts` serves paths under it from the pack and every
 * other path from the real filesystem.
 *
 * Memory: the whole compressed data part (~30 MiB) is copied into the JS heap
 * once at start-up, by design. Content readers are synchronous, and the only
 * way to read an embedded file partially is the async `Blob.slice()` — the
 * embedded path does not support `openSync`/`readSync`, and `Bun.mmap` is not
 * available on Windows. Measured in a compiled binary with a 30 MB embedded
 * file: `blob.arrayBuffer()` raised RSS by about one file size per call, and a
 * 100-byte `slice().arrayBuffer()` by about nothing. So reading per file with
 * slices would save roughly one copy of the compressed data, at the cost of
 * making every content reader async. The decoded corpus is never held as a
 * whole: each read decodes one file into a buffer the caller owns.
 *
 * Outside a compiled binary (`bun start`, `bun dev`, tests) nothing is
 * mounted: the content is read from the plain files in the checkout.
 */

import { dirname, join } from "node:path";
import { ContentPack, type ContentPackParts } from "./content_pack.ts";

/** Name prefix of the embedded pack parts (Bun appends a content hash to each name). */
export const BUNDLED_CONTENT_PREFIX = "tableau-ai-eval-content";

/** File name of each embedded part. Basenames must differ, or `bun build` maps them to one output. */
export const BUNDLED_CONTENT_FILES = {
  index: `${BUNDLED_CONTENT_PREFIX}-index.zst`,
  dictionary: `${BUNDLED_CONTENT_PREFIX}-dictionary.zdict`,
  data: `${BUNDLED_CONTENT_PREFIX}-data.bin`,
} as const;

type Part = keyof typeof BUNDLED_CONTENT_FILES;

/** True when running from a `bun build --compile` binary. */
export function isCompiledBinary(): boolean {
  const b = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun;
  if (b && typeof b.isStandaloneExecutable === "boolean") return b.isStandaloneExecutable;
  const u = import.meta.url;
  return u.includes("/$bunfs/") || u.includes("/~BUN/") || u.includes("B~");
}

let mounted: { pack: ContentPack; root: string } | null = null;
let preparing: Promise<string | null> | null = null;

/**
 * Where the embedded pack is mounted: a directory beside the binary whose
 * name cannot be created on Windows, so it never shadows real files.
 */
export function defaultBundledContentRoot(): string {
  return join(dirname(process.execPath), "<bundled>");
}

/** Mount `pack` at `root` (null unmounts). Used at start-up and by tests. */
export function mountContentPack(pack: ContentPack | null, root: string = defaultBundledContentRoot()): void {
  mounted = pack ? { pack, root } : null;
}

/** The mounted pack and its root, or null. */
export function mountedContent(): { pack: ContentPack; root: string } | null {
  return mounted;
}

/** `name` is `<prefix>-<part>.<ext>` with an optional `-<hash>` Bun adds before the extension. */
function partOf(name: string): Part | null {
  for (const [part, file] of Object.entries(BUNDLED_CONTENT_FILES) as [Part, string][]) {
    const dot = file.lastIndexOf(".");
    const stem = file.slice(0, dot);
    const ext = file.slice(dot);
    if (name === file || (name.startsWith(`${stem}-`) && name.endsWith(ext))) return part;
  }
  return null;
}

/**
 * Open the pack held by `files` (the binary's `Bun.embeddedFiles`). Null when
 * no part is embedded; throws when only some are, or the pack is invalid.
 */
export async function openEmbeddedContent(files: ReadonlyArray<Blob>): Promise<ContentPack | null> {
  const found: Partial<Record<Part, Blob>> = {};
  for (const f of files) {
    const part = partOf((f as Blob & { name?: string }).name ?? "");
    if (part) found[part] = f;
  }
  const missing = (Object.keys(BUNDLED_CONTENT_FILES) as Part[]).filter((p) => !found[p]);
  if (missing.length === 3) return null;
  if (missing.length) throw new Error(`embedded test content is incomplete (missing ${missing.join(", ")})`);
  const bytes = async (p: Part) => new Uint8Array(await found[p]!.arrayBuffer());
  const parts: ContentPackParts = {
    index: await bytes("index"),
    dictionary: await bytes("dictionary"),
    data: await bytes("data"),
  };
  return ContentPack.open(parts);
}

/**
 * Mount the embedded content (compiled binary only). Idempotent; resolves to
 * the content root, or null when not compiled / nothing is embedded. Call once
 * at start-up before anything resolves a suite path.
 */
export function prepareBundledContent(): Promise<string | null> {
  if (preparing) return preparing;
  preparing = (async () => {
    if (!isCompiledBinary()) return null;
    const files = (globalThis as { Bun?: { embeddedFiles?: ReadonlyArray<Blob> } }).Bun?.embeddedFiles ?? [];
    const pack = await openEmbeddedContent(files);
    if (!pack) return null;
    mountContentPack(pack);
    return mounted!.root;
  })();
  return preparing;
}

/**
 * The root the embedded content is mounted at (holds `public-suites/`,
 * `prep-bench/`), or null when nothing is mounted — before
 * {@link prepareBundledContent} finished, or outside a compiled binary.
 */
export function bundledContentRoot(): string | null {
  return mounted?.root ?? null;
}
