/**
 * Retrain the zstd dictionary the release's content pack is compressed with
 * (`scripts/content.zdict`, committed). Run it when the test content changes
 * substantially — a new suite, a reshaped case format, or new datasets
 * — and commit the new dictionary. Building and running the release never
 * needs zstd; only this script does (the `zstd` CLI, 1.4+, on PATH).
 *
 * Usage: `bun run train-dict [--size=65536] [--dry-run]`
 *
 * The training set is every text file of the content dirs (already-compressed
 * files such as `.tdsx` are skipped), passed to zstd by path through a file
 * list — the content is never copied. Before writing, the script compresses
 * the whole content with the old and the new dictionary in Bun and prints both
 * sizes; `--dry-run` stops there.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlreadyCompressed } from "../packages/core/src/content_pack.ts";
import { CONTENT_DICTIONARY, listContent, packContent } from "./bundle-content.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const size = Number(args.find((a) => a.startsWith("--size="))?.slice(7) ?? 64 * 1024);
const dryRun = args.includes("--dry-run");
if (!Number.isInteger(size) || size < 4096) throw new Error(`--size must be an integer >= 4096, got ${size}`);

const zstd = Bun.which("zstd");
if (!zstd) {
  console.error("zstd not found on PATH. Install it (winget install Facebook.zstd / brew install zstd / apt install zstd).");
  process.exit(1);
}

const samples = listContent(root).filter((f) => f.size > 0 && !isAlreadyCompressed(readFileSync(f.path).subarray(0, 8)));
console.log(`Training a ${size}-byte dictionary on ${samples.length} files ...`);

const tmp = mkdtempSync(join(tmpdir(), "tableau-ai-eval-train-"));
try {
  const list = join(tmp, "files.txt");
  const out = join(tmp, "content.zdict");
  writeFileSync(list, samples.map((f) => f.path).join("\n"));
  const r = Bun.spawnSync([zstd, "--train", "--filelist", list, `--maxdict=${size}`, "-q", "-f", "-o", out]);
  if (r.exitCode !== 0 || !existsSync(out)) {
    console.error(r.stderr.toString() || `zstd exited with ${r.exitCode}`);
    process.exit(1);
  }
  const fresh = readFileSync(out);
  const target = join(root, CONTENT_DICTIONARY);
  const mib = (n: number) => `${(n / 1048576).toFixed(2)} MiB`;
  const report = (label: string, dict: Uint8Array) => {
    const p = packContent(root, dict);
    const total = p.index.length + p.dictionary.length + p.data.length;
    console.log(`  ${label}: ${mib(total)} packed (${(dict.length / 1024).toFixed(1)} KiB dictionary)`);
    return total;
  };
  console.log(`Content: ${mib(listContent(root).reduce((n, f) => n + f.size, 0))}`);
  const before = existsSync(target) ? report("current dictionary", readFileSync(target)) : null;
  const after = report("new dictionary    ", fresh);
  if (before !== null) console.log(`  change: ${(((after - before) / before) * 100).toFixed(2)}%`);
  if (dryRun) {
    console.log("Dry run: dictionary not written.");
  } else {
    writeFileSync(target, fresh);
    console.log(`Wrote ${CONTENT_DICTIONARY}. Commit it.`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
