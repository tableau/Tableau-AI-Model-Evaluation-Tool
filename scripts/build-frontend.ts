/**
 * Builds the Vite frontend (packages/frontend) into packages/frontend/build.
 *
 * The build output is git-ignored, so a fresh checkout has none and `bun start`
 * would serve the placeholder UI. This script produces the build so:
 *   - the root `postinstall` gives `bun start` a real UI with zero manual steps,
 *   - `scripts/build.ts` has the HTMLBundle static import target before compiling,
 *   - `prestart` can rebuild it when the frontend source changed (`--if-stale`).
 *
 * Reused by all three; can also be run standalone:
 *   bun run scripts/build-frontend.ts             # build only if missing
 *   bun run scripts/build-frontend.ts --if-stale  # build if missing OR stale
 *   FORCE_FRONTEND_BUILD=1 bun run scripts/...     # always rebuild
 *
 * The frontend is a Bun workspace, so its deps are already installed into the
 * root node_modules by `bun install` — this script does NOT run a nested
 * `bun install` (a nested install from within a workspace member stalls).
 *
 * SKIP_FRONTEND_BUILD=1 short-circuits when a build already exists (used by CI /
 * repeat `bun run build` invocations that don't need to rebuild the frontend).
 */

import { $ } from "bun";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const frontendDir = join(root, "packages", "frontend");
export const frontendIndex = join(frontendDir, "build", "index.html");

// High-signal build inputs: source, entry HTML, static assets, and the config
// that changes output (Vite/tsconfig/deps). Deliberately NOT node_modules — a
// dep bump lands via `bun install`, whose postinstall rebuilds the frontend, and
// bun.lock (a direct input here) also moves then. Everything under `build/` is
// the OUTPUT and is excluded from the walk.
const INPUT_ROOTS = ["src", "public"];
const INPUT_FILES = [
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.node.json",
  "package.json",
  join("..", "..", "bun.lock"), // repo-root lockfile: dep changes to the frontend
];

/** Newest mtime (ms) among existing paths; walks directories recursively. */
function newestMtime(paths: string[]): number {
  let newest = 0;
  const visit = (p: string): void => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      return; // missing input — ignore (can't be newer than the build)
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(p);
      } catch {
        return;
      }
      for (const name of entries) visit(join(p, name));
      return;
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const p of paths) visit(p);
  return newest;
}

/**
 * True when the build is missing, or any frontend input is newer than the built
 * `index.html`. mtime-based: cheap (a few hundred stats), and a false positive
 * (e.g. a `git pull` that bumps mtimes without changing frontend source) only
 * costs one ~3s rebuild — never serves stale UI.
 */
export function isFrontendStale(directory = frontendDir): boolean {
  let buildMtime: number;
  try {
    buildMtime = statSync(join(directory, "build", "index.html")).mtimeMs;
  } catch {
    return true; // no build yet
  }
  const inputMtime = newestMtime([...INPUT_ROOTS, ...INPUT_FILES].map((p) => join(directory, p)));
  return inputMtime > buildMtime;
}

/**
 * Build the frontend. Returns the built index.html path.
 *
 * @param opts.force    Rebuild even if a build already exists.
 * @param opts.ifStale  Rebuild when missing OR stale (mtime check); a present +
 *                       up-to-date build is left alone.
 * @param opts.require   Throw if the build is missing afterwards (compile needs it).
 */
export async function buildFrontend(
  opts: { force?: boolean; ifStale?: boolean; require?: boolean } = {},
): Promise<string> {
  const force = opts.force ?? process.env.FORCE_FRONTEND_BUILD === "1";
  const skip = process.env.SKIP_FRONTEND_BUILD === "1";
  const present = existsSync(frontendIndex);
  const stale = opts.ifStale ? isFrontendStale() : false;

  const build =
    force || (!skip && (!present || (opts.ifStale && stale)));

  if (!build) {
    if (present) console.log("Frontend build up to date; skipping.");
    else console.log("Skipping frontend build (SKIP_FRONTEND_BUILD=1).");
  } else {
    const why = !present ? "missing" : force ? "forced" : "source changed";
    console.log(`Building frontend (Vite) -> packages/frontend/build (${why}) ...`);
    // No nested `bun install`: workspace deps are already in root node_modules.
    await $`${process.execPath} run build`.cwd(frontendDir);
  }

  if (opts.require && !existsSync(frontendIndex)) {
    throw new Error(
      `frontend build missing at ${frontendIndex}; the compiled binary would ` +
        "fall back to the placeholder UI. Build the frontend first.",
    );
  }
  return frontendIndex;
}

if (import.meta.main) {
  await buildFrontend({ ifStale: process.argv.includes("--if-stale") });
}
