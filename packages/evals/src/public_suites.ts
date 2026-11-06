/**
 * Where the tool's bundled `public-suites/` folder is, as seen from
 * `@tableau-ai-eval/evals`. Adapters that ship their cases with the tool (Color
 * palettes, Questions about a dashboard) read them from here.
 *
 * This repeats `publicSuitesRoot` in `@tableau-ai-eval/server`
 * (`suites/public_content.ts`) because `evals` cannot import `server`. The
 * order is the same: `TABLEAU_AI_EVAL_PUBLIC_SUITES` → the copy embedded in the compiled binary →
 * the repo root in dev.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledContentRoot, contentIsDir } from "@tableau-ai-eval/core";

const isDir = contentIsDir;

function isCompiled(): boolean {
  const b = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun;
  if (b && typeof b.isStandaloneExecutable === "boolean") return b.isStandaloneExecutable;
  const u = import.meta.url;
  return u.includes("/$bunfs/") || u.includes("/~BUN/") || u.includes("B~");
}

/** The `public-suites/` root (it may not exist on disk). */
export function publicSuitesRootPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TABLEAU_AI_EVAL_PUBLIC_SUITES;
  if (override) return resolve(override);
  if (isCompiled()) {
    return join(bundledContentRoot() ?? dirname(process.execPath), "public-suites");
  }
  // packages/evals/src → repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public-suites");
}

/** `<public-suites>/<subdir>` when it is a directory, else null. */
export function bundledDir(subdir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const p = join(publicSuitesRootPath(env), subdir);
  return isDir(p) ? p : null;
}
