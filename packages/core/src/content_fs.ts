/**
 * File access for the test content. A path under the mounted content pack
 * (`bundledContentRoot()`, compiled binary only) is served from the pack,
 * decompressing just the file asked for; any other path — the checkout in
 * `bun start`/`bun dev`, `TABLEAU_AI_EVAL_*` overrides, a custom suite folder — is read
 * from the real filesystem. Errors carry Node's `ENOENT`/`ENOTDIR`/`EISDIR`
 * codes either way, so callers handle both alike.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mountedContent } from "./bundled_content.ts";
import type { ContentPack } from "./content_pack.ts";

/** The pack and the POSIX name inside it for `path`, or null when the path is not mounted. */
function packed(path: string): { pack: ContentPack; name: string } | null {
  const m = mountedContent();
  if (!m) return null;
  const rel = relative(m.root, resolve(path));
  if (rel === "") return { pack: m.pack, name: "" };
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return { pack: m.pack, name: rel.split(sep).join("/") };
}

function fsError(code: "ENOENT" | "ENOTDIR" | "EISDIR", syscall: string, path: string): NodeJS.ErrnoException {
  const text = { ENOENT: "no such file or directory", ENOTDIR: "not a directory", EISDIR: "illegal operation on a directory" };
  const err = new Error(`${code}: ${text[code]}, ${syscall} '${path}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}

export function contentIsDir(path: string): boolean {
  const p = packed(path);
  if (p) return p.pack.isDir(p.name);
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function contentIsFile(path: string): boolean {
  const p = packed(path);
  if (p) return p.pack.isFile(p.name);
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function contentExists(path: string): boolean {
  const p = packed(path);
  if (p) return p.pack.isFile(p.name) || p.pack.isDir(p.name);
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Entry names of a directory (like `readdirSync`); packed listings are sorted. */
export function contentReaddir(path: string): string[] {
  const p = packed(path);
  if (!p) return readdirSync(path);
  const names = p.pack.list(p.name);
  if (names) return names;
  throw fsError(p.pack.isFile(p.name) ? "ENOTDIR" : "ENOENT", "scandir", path);
}

export function contentReadBytes(path: string): Uint8Array {
  const p = packed(path);
  if (!p) return readFileSync(path);
  const bytes = p.pack.read(p.name);
  if (bytes) return bytes;
  throw fsError(p.pack.isDir(p.name) ? "EISDIR" : "ENOENT", "open", path);
}

/** A file as UTF-8 text (like `readFileSync(path, "utf-8")`, BOM kept). */
export function contentReadText(path: string): string {
  const p = packed(path);
  if (!p) return readFileSync(path, "utf-8");
  return Buffer.from(contentReadBytes(path)).toString("utf-8");
}

/**
 * A value that changes when a directory's contents may have changed: the
 * real directory's mtime, a constant for the (immutable) pack, null when it
 * does not exist.
 */
export function contentStamp(path: string): number | null {
  const p = packed(path);
  if (p) return p.pack.isDir(p.name) || p.pack.isFile(p.name) ? 0 : null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
