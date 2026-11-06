/**
 * The test content that `bun release` embeds in the binary: every file under
 * the content dirs, named by its repo-relative path. Names always use `/`,
 * whatever the build OS, so a Windows build makes the same pack as a macOS or
 * Linux one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ContentPackWriter, type ContentPackParts } from "../packages/core/src/content_pack.ts";

/** The content dirs, as they sit at the repo root (and in the mounted pack). */
export const CONTENT_DIRS = ["public-suites", "prep-bench"] as const;

/** The committed zstd dictionary the pack is compressed with (`bun run train-dict` rebuilds it). */
export const CONTENT_DICTIONARY = join("scripts", "content.zdict");

/** Never shipped: VCS metadata (a submodule's `.git` is a file pointing elsewhere). */
const SKIP = new Set([".git", ".DS_Store"]);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Repo-relative POSIX name for an on-disk path under `root`. */
export function archiveName(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export interface ContentFile {
  name: string;
  path: string;
  size: number;
}

/** Every content file under `root`, sorted by name. Reads no file contents. */
export function listContent(root: string, dirs: readonly string[] = CONTENT_DIRS): ContentFile[] {
  const out: ContentFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ name: archiveName(root, p), path: p, size: statSync(p).size });
    }
  };
  for (const d of dirs) {
    const p = join(root, d);
    if (isDir(p)) walk(p);
    else {
      console.warn(`WARNING: ${d} not found at ${p}`);
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Pack every content file under `root`, reading one file at a time. */
export function packContent(
  root: string,
  dictionary: Uint8Array,
  dirs: readonly string[] = CONTENT_DIRS,
): ContentPackParts & { count: number; rawBytes: number } {
  const writer = new ContentPackWriter(dictionary);
  let rawBytes = 0;
  for (const f of listContent(root, dirs)) {
    const bytes = readFileSync(f.path);
    rawBytes += bytes.length;
    writer.add(f.name, bytes);
  }
  return { ...writer.finish(), count: writer.count, rawBytes };
}
