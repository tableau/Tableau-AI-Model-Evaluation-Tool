/**
 * The indexed test-content pack the compiled binary embeds (see
 * `bundled_content.ts`). Three parts, each embedded as its own file:
 *
 *   - `index`      — zstd-compressed JSON: format version, the dictionary's
 *                    hash, and one `[name, offset, length, size, codec]` row per
 *                    file (POSIX names relative to the repo root);
 *   - `dictionary` — the shared zstd dictionary (committed, trained by
 *                    `bun run train-dict`);
 *   - `data`       — every file's bytes back to back. Text is one independent
 *                    zstd frame per file, compressed with the dictionary; files
 *                    that are already compressed (`.tdsx` ZIPs, images) or do
 *                    not shrink are stored as they are.
 *
 * A read decodes just the requested file; nothing is extracted to disk and the
 * corpus is never decoded as a whole. All compression runs on Bun's built-in
 * zstd (`node:zlib`), so neither building nor reading needs a zstd install.
 */

import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const CONTENT_PACK_VERSION = 1;

/** zstd level used for file frames: level 15+ saves ~0.6% for ~5x pack time. */
export const CONTENT_PACK_LEVEL = 9;

const RAW = 0;
const ZSTD_DICT = 1;

/** `[name, offset, stored length, decoded size, codec]`. */
type IndexRow = [string, number, number, number, number];

interface IndexDoc {
  version: number;
  dictionary: string;
  data: number;
  entries: IndexRow[];
}

export interface ContentPackParts {
  index: Uint8Array;
  dictionary: Uint8Array;
  data: Uint8Array;
}

/** Hash that ties an index to the dictionary its frames were compressed with. */
export function dictionaryId(dictionary: Uint8Array): string {
  return Bun.hash(dictionary).toString(16).padStart(16, "0");
}

/** True for bytes that zstd cannot usefully shrink: ZIP (`.tdsx`), gzip, zstd, PNG, JPEG. */
export function isAlreadyCompressed(b: Uint8Array): boolean {
  return (
    (b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6))) ||
    (b[0] === 0x1f && b[1] === 0x8b) ||
    (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) ||
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
  );
}

/** A relative POSIX name with no empty, `.` or `..` segments. */
function validName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || /^[A-Za-z]:/.test(name)) {
    return false;
  }
  return name.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Builds a pack one file at a time; only compressed bytes are kept. */
export class ContentPackWriter {
  private readonly rows: IndexRow[] = [];
  private readonly chunks: Uint8Array[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private readonly options: Parameters<typeof zstdCompressSync>[1];

  constructor(
    private readonly dictionary: Uint8Array,
    level: number = CONTENT_PACK_LEVEL,
  ) {
    this.options = {
      dictionary,
      params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_checksumFlag]: 1 },
    };
  }

  add(name: string, bytes: Uint8Array): void {
    if (!validName(name)) throw new Error(`unsafe content name: ${name}`);
    if (this.names.has(name)) throw new Error(`duplicate content name: ${name}`);
    this.names.add(name);
    let stored = bytes;
    let codec = RAW;
    if (bytes.length > 0 && !isAlreadyCompressed(bytes)) {
      const frame = zstdCompressSync(bytes, this.options);
      if (frame.length < bytes.length) {
        stored = frame;
        codec = ZSTD_DICT;
      }
    }
    this.rows.push([name, this.offset, stored.length, bytes.length, codec]);
    this.chunks.push(stored);
    this.offset += stored.length;
  }

  get count(): number {
    return this.rows.length;
  }

  finish(): ContentPackParts {
    const doc: IndexDoc = {
      version: CONTENT_PACK_VERSION,
      dictionary: dictionaryId(this.dictionary),
      data: this.offset,
      entries: [...this.rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    };
    const index = zstdCompressSync(Buffer.from(JSON.stringify(doc)), {
      params: { [constants.ZSTD_c_compressionLevel]: 19, [constants.ZSTD_c_checksumFlag]: 1 },
    });
    return { index, dictionary: this.dictionary, data: Buffer.concat(this.chunks) };
  }
}

interface Entry {
  offset: number;
  length: number;
  size: number;
  codec: number;
}

/** A read-only view of a pack. Directories are implied by file names. */
export class ContentPack {
  private readonly files = new Map<string, Entry>();
  private readonly dirs = new Map<string, Set<string>>([["", new Set()]]);

  private constructor(
    private readonly dictionary: Uint8Array,
    private readonly data: Uint8Array,
  ) {}

  /** Validate and open a pack. Throws on any inconsistency. */
  static open(parts: ContentPackParts): ContentPack {
    let doc: IndexDoc;
    try {
      doc = JSON.parse(Buffer.from(zstdDecompressSync(parts.index)).toString("utf-8"));
    } catch (err) {
      throw new Error(`content pack index is unreadable: ${err instanceof Error ? err.message : err}`);
    }
    if (doc?.version !== CONTENT_PACK_VERSION) {
      throw new Error(`content pack version ${doc?.version} is not supported (expected ${CONTENT_PACK_VERSION})`);
    }
    if (doc.dictionary !== dictionaryId(parts.dictionary)) {
      throw new Error("content pack dictionary does not match its index");
    }
    if (doc.data !== parts.data.length || !Array.isArray(doc.entries)) {
      throw new Error("content pack data does not match its index");
    }
    const pack = new ContentPack(parts.dictionary, parts.data);
    for (const row of doc.entries) {
      const [name, offset, length, size, codec] = Array.isArray(row) ? row : [];
      const ints = [offset, length, size].every((n) => Number.isSafeInteger(n) && (n as number) >= 0);
      if (typeof name !== "string" || !validName(name) || !ints) throw new Error(`bad content pack entry: ${row}`);
      if (codec !== RAW && codec !== ZSTD_DICT) throw new Error(`unknown codec ${codec} for ${name}`);
      if (codec === RAW && length !== size) throw new Error(`bad stored length for ${name}`);
      if ((offset as number) + (length as number) > parts.data.length) throw new Error(`${name} lies outside the data`);
      if (pack.files.has(name) || pack.dirs.has(name)) throw new Error(`duplicate content name: ${name}`);
      pack.files.set(name, { offset: offset as number, length: length as number, size: size as number, codec });
      const segments = name.split("/");
      for (let i = 0; i < segments.length; i++) {
        const parent = segments.slice(0, i).join("/");
        const child = segments[i]!;
        let set = pack.dirs.get(parent);
        if (!set) {
          if (pack.files.has(parent)) throw new Error(`${parent} is both a file and a directory`);
          set = new Set();
          pack.dirs.set(parent, set);
        }
        set.add(child);
      }
    }
    for (const name of pack.files.keys()) {
      if (pack.dirs.has(name)) throw new Error(`${name} is both a file and a directory`);
    }
    return pack;
  }

  get fileCount(): number {
    return this.files.size;
  }

  isFile(name: string): boolean {
    return this.files.has(name);
  }

  /** `""` is the root. */
  isDir(name: string): boolean {
    return this.dirs.has(name);
  }

  /** Decoded size of a file, or null when there is none. */
  size(name: string): number | null {
    return this.files.get(name)?.size ?? null;
  }

  /** Sorted child names of a directory, or null when it is not one. */
  list(name: string): string[] | null {
    const set = this.dirs.get(name);
    return set ? [...set].sort() : null;
  }

  /** A file's bytes (a fresh buffer the caller owns), or null when there is none. */
  read(name: string): Uint8Array | null {
    const e = this.files.get(name);
    if (!e) return null;
    const stored = this.data.subarray(e.offset, e.offset + e.length);
    // A copy: Buffer#slice would be a view the caller could write through.
    if (e.codec === RAW) return new Uint8Array(stored);
    let out: Uint8Array;
    try {
      out = zstdDecompressSync(stored, { dictionary: this.dictionary, maxOutputLength: e.size });
    } catch (err) {
      throw new Error(`content pack entry ${name} is corrupt: ${err instanceof Error ? err.message : err}`);
    }
    if (out.length !== e.size) throw new Error(`content pack entry ${name} is corrupt: wrong size`);
    return out;
  }
}
