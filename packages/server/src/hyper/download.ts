import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCaBundlePath, tlsInit } from "@tableau-ai-eval/core";
import { hyperdBinaryName, nativeNodeFileName, platformPackage } from "./platform.ts";
import { HYPER_RELEASE_INTEGRITY, HYPER_RELEASE_VERSION } from "./release.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface DownloadOptions {
  cacheRoot?: string;
  fetchImpl?: typeof fetch;
  integrity?: string;
  /** Private CA fallback only; npm normally uses the runtime's public trust roots. */
  caBundlePath?: string | null;
}

function isCertificateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return /certificate|local issuer|self.signed|unable.to.verify|CERT_|UNKNOWN_CA/i.test(`${message} ${code}`);
}

async function downloadArchive(url: string, opts: DownloadOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(300_000);
  try {
    // A Tableau-specific CA bundle replaces public roots when passed as tls.ca.
    // Try npm with default public trust first, so that bundle cannot break npm TLS.
    return await fetchImpl(url, { signal, ...tlsInit({ verify: true }) });
  } catch (error) {
    const caBundlePath = opts.caBundlePath === undefined ? resolveCaBundlePath() : opts.caBundlePath;
    if (!isCertificateError(error) || !caBundlePath) throw error;
    // Corporate TLS interception may need the operator's private CA instead.
    return await fetchImpl(url, { signal, ...tlsInit({ verify: true, caBundlePath }) });
  }
}

/** Only called by standalone executables. No npm CLI or external extractor needed. */
export async function ensureReleasePackage(tag: string, opts: DownloadOptions = {}): Promise<string> {
  const integrity = opts.integrity ?? HYPER_RELEASE_INTEGRITY[tag];
  if (!integrity) throw new Error(`Hyper is not available for ${tag} in release ${HYPER_RELEASE_VERSION}.`);
  const parent = join(opts.cacheRoot ?? join(homedir(), ".tableau-ai-eval", "bin", "hyperdb-api-node"), HYPER_RELEASE_VERSION);
  const target = join(parent, tag);
  const names = [nativeNodeFileName(tag), hyperdBinaryName(tag.startsWith("win32") ? "win32" : "linux")];
  const valid = async () => {
    try {
      const manifest = JSON.parse(await readFile(join(target, "verified.json"), "utf8")) as {
        integrity: string; hashes: Record<string, string>;
      };
      return manifest.integrity === integrity && (await Promise.all(names.map(async (name) =>
        manifest.hashes[name] === sha256(await readFile(join(target, name))),
      ))).every(Boolean);
    } catch {
      return false;
    }
  };
  if (await valid()) return target;

  let staging: string | undefined;
  try {
    await mkdir(parent, { recursive: true });
    staging = await mkdtemp(join(parent, `.${tag}-`));
    const pkg = platformPackage(tag);
    const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${HYPER_RELEASE_VERSION}.tgz`;
    const response = await downloadArchive(url, opts);
    if (!response.ok) throw new Error(`npm download returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (actual !== integrity) throw new Error("npm package integrity check failed");

    const files = await new Bun.Archive(bytes).files();
    const hashes: Record<string, string> = {};
    for (const name of names) {
      const file = files.get(`package/${name}`);
      if (!file) throw new Error(`npm package is missing ${name}`);
      const content = new Uint8Array(await file.arrayBuffer());
      hashes[name] = sha256(content);
      await writeFile(join(staging, name), content);
      if (!tag.startsWith("win32")) await chmod(join(staging, name), 0o755);
    }
    const license = files.get("package/LICENSE-HYPERD");
    if (license) await writeFile(join(staging, "LICENSE-HYPERD"), new Uint8Array(await license.arrayBuffer()));
    await writeFile(join(staging, "verified.json"), JSON.stringify({ integrity, hashes }));
    // Another process may have finished while we downloaded. Never overwrite a valid cache.
    if (await valid()) return target;
    if (existsSync(target)) await rm(target, { recursive: true, force: true });
    try {
      await rename(staging, target);
    } catch (error) {
      if (!(await valid())) throw error;
    }
    return target;
  } catch (error) {
    const hint = isCertificateError(error)
      ? "TLS certificate verification failed for registry.npmjs.org. Configure TABLEAU_AI_EVAL_CA_BUNDLE with a PEM bundle that trusts the registry (including your corporate proxy CA, if applicable)."
      : `Check internet access and write permission to ${parent}.`;
    throw new Error(`Could not download/install Hyper ${HYPER_RELEASE_VERSION} (${tag}): ${error instanceof Error ? error.message : String(error)}. ${hint}`, { cause: error });
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
