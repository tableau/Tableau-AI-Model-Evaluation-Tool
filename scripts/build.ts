/** Standalone compilation; shared by local builds and release packaging. */
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_CONTENT_FILES } from "../packages/core/src/bundled_content.ts";
import { ContentPack } from "../packages/core/src/content_pack.ts";
import { platformTag } from "../packages/server/src/hyper/platform.ts";
import { HYPER_RELEASE_INTEGRITY } from "../packages/server/src/hyper/release.ts";
import { buildFrontend } from "./build-frontend.ts";
import { CONTENT_DICTIONARY, packContent } from "./bundle-content.ts";
import { generateCalcParser } from "./generate-calc-parser.ts";
import { generatePrepParser } from "./generate-prep-parser.ts";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The tool's icon, for the Windows executable (a 16, 32 and 48 pixel ICO). */
export const WINDOWS_ICON = "packages/frontend/public/favicon.ico";
export const PRODUCT_NAME = "Tableau AI Model Evaluation Tool";

export const TARGETS = {
  "darwin-arm64": { bun: "bun-darwin-arm64", hyper: "darwin-arm64", executable: "tableau-ai-eval" },
  "linux-x64": { bun: "bun-linux-x64-baseline", hyper: "linux-x64-gnu", executable: "tableau-ai-eval" },
  "windows-x64": { bun: "bun-windows-x64-baseline", hyper: "win32-x64-msvc", executable: "tableau-ai-eval.exe" },
} as const;
export type Target = keyof typeof TARGETS;
export const ALL_TARGETS = Object.keys(TARGETS) as Target[];

export function parseTarget(value: string): Target {
  if (!Object.hasOwn(TARGETS, value)) throw new Error(`Unsupported target ${value}. Choose: ${ALL_TARGETS.join(", ")}.`);
  return value as Target;
}

export function nativeTarget(): Target {
  const tag = platformTag();
  const target = ALL_TARGETS.find((name) => TARGETS[name].hyper === tag);
  if (!target) throw new Error(`No pinned Hyper release for ${process.platform}-${process.arch} (${tag}). Use --target or --all to cross-compile.`);
  return target;
}

export interface CompiledArtifact { target: Target; path: string }

/** Prepare embedded assets once; never delete unrelated files from dist. */
export async function compileTargets(targets: readonly Target[], nativeOutput = false): Promise<CompiledArtifact[]> {
  for (const target of targets) {
    if (!HYPER_RELEASE_INTEGRITY[TARGETS[target].hyper]) throw new Error(`No pinned Hyper release for ${target}.`);
  }
  await generateCalcParser();
  await generatePrepParser();
  await buildFrontend({ ifStale: true, require: true });
  const dictionaryPath = join(ROOT, CONTENT_DICTIONARY);
  if (!existsSync(dictionaryPath)) throw new Error(`${CONTENT_DICTIONARY} missing: run \`bun run train-dict\``);
  const contentTmp = mkdtempSync(join(tmpdir(), "tableau-ai-eval-content-"));
  try {
    const pack = packContent(ROOT, readFileSync(dictionaryPath));
    ContentPack.open(pack);
    const parts = ["index", "dictionary", "data"] as const;
    const contentParts = parts.map((part) => join(contentTmp, BUNDLED_CONTENT_FILES[part]));
    for (const [i, part] of parts.entries()) await Bun.write(contentParts[i]!, pack[part]);
    console.log(`Packed ${pack.count} test-content files.`);
    const artifacts: CompiledArtifact[] = [];
    for (const target of targets) {
      const dir = nativeOutput ? join(ROOT, "dist") : join(ROOT, "dist", "targets", target);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, TARGETS[target].executable);
      console.log(`Compiling ${target} -> ${path}`);
      const scoringWorker = join(ROOT, "packages/evals/src/metrics/narrative_worker.ts");
      // A Windows executable carries the tool's icon and name; a macOS or
      // Linux binary has nowhere to put them (the release ZIP ships the logo).
      // Bun writes those resources only when the build itself runs on
      // Windows, so a Windows executable cross-compiled from a Mac ships
      // without them.
      const windowsFlags = target === "windows-x64" && process.platform === "win32"
        ? [`--windows-icon=${join(ROOT, WINDOWS_ICON)}`, `--windows-title=${PRODUCT_NAME}`]
        : [];
      if (target === "windows-x64" && !windowsFlags.length) {
        console.log("Note: the Windows executable gets its icon and product name only when compiled on Windows.");
      }
      // Temporary content inputs must not change the embedded worker's path.
      await $`${process.execPath} build ${join(ROOT, "packages/server/src/cli.ts")} ${scoringWorker} ${contentParts} --root ${ROOT} --compile --target ${TARGETS[target].bun} ${windowsFlags} --outfile ${path}`.cwd(ROOT);
      artifacts.push({ target, path });
    }
    return artifacts;
  } finally {
    rmSync(contentTmp, { recursive: true, force: true });
  }
}

export function compileOptions(args: string[]): { targets: Target[]; nativeOutput: boolean } {
  if (args.length === 0) return { targets: [nativeTarget()], nativeOutput: true };
  if (args.length === 1 && args[0] === "--all") return { targets: [...ALL_TARGETS], nativeOutput: false };
  if (args.length === 2 && args[0] === "--target") return { targets: [parseTarget(args[1]!)], nativeOutput: false };
  throw new Error("Usage: bun compile [--all | --target darwin-arm64|linux-x64|windows-x64]");
}

if (import.meta.main) {
  try {
    const opts = compileOptions(process.argv.slice(2));
    await compileTargets(opts.targets, opts.nativeOutput);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
