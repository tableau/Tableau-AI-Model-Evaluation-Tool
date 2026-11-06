/** Local ZIP packaging and explicit GitHub publication. No workflows required. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { ALL_TARGETS, ROOT, TARGETS, compileTargets, nativeTarget, parseTarget, type CompiledArtifact, type Target } from "./build.ts";

export const RELEASE_DOCS = ["README.md", "LICENSE.txt", "SECURITY.md"] as const;
/** Files shipped in every ZIP under another name: the tool's logo, for a
 *  shortcut or a desktop icon on a computer whose binary cannot carry one. */
export const RELEASE_ASSETS = { "tableau-ai-eval-logo.png": "packages/frontend/public/logo512.png" } as const;
export interface ReleaseOptions { all: boolean; target?: Target; noBuild: boolean; public: boolean; hostname?: string }
export interface ReleaseArtifact { target: Target; file: string; sha256: string }
export interface ReleaseManifest {
  schema: 1;
  version: string;
  tag: string;
  commit: string;
  clean: boolean;
  artifacts: ReleaseArtifact[];
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (args) => {
  const proc = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

async function command(run: CommandRunner, args: string[]): Promise<string> {
  const result = await run(args);
  if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  return result.stdout;
}

export function releaseVersion(root = ROOT): { version: string; tag: string } {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : undefined;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error("package.json must contain a valid release version (for example, 0.1.0).");
  }
  return { version, tag: `v${version}` };
}

export function releaseOptions(args: string[], publish: boolean): ReleaseOptions {
  const opts: ReleaseOptions = { all: publish, noBuild: false, public: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error(`Duplicate option ${arg}.`);
    seen.add(arg);
    if (arg === "--all") opts.all = true;
    else if (arg === "--target" && !publish && args[i + 1]) opts.target = parseTarget(args[++i]!);
    else if (arg === "--no-build" && publish) opts.noBuild = true;
    else if (arg === "--public" && publish) opts.public = true;
    else if (arg === "--hostname" && publish && args[i + 1]) opts.hostname = validateHostname(args[++i]!);
    else throw new Error(`Unknown option ${arg}. Usage: bun ${publish ? "release:publish [--no-build] [--public] [--hostname <host>]" : "release [--all | --target <target>]"}`);
  }
  if (opts.target && opts.all) throw new Error("Choose --all or --target, not both.");
  return opts;
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Unix modes in the central directory survive extraction on macOS/Linux. */
export function releaseZip(executable: string, binary: Uint8Array, docs: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const files: Zippable = {};
  const mtime = new Date("2000-01-01T00:00:00Z");
  files[executable] = [binary, { level: 6, os: 3, attrs: (0o100755 << 16) >>> 0, mtime }];
  for (const [name, data] of Object.entries(docs)) files[name] = [data, { level: 6, os: 3, attrs: (0o100644 << 16) >>> 0, mtime }];
  return zipSync(files);
}

export function packageRelease(
  artifacts: readonly CompiledArtifact[], metadata: Omit<ReleaseManifest, "schema" | "artifacts">, root = ROOT,
): { directory: string; manifest: ReleaseManifest } {
  const directory = join(root, "dist", "releases", metadata.tag);
  mkdirSync(directory, { recursive: true });
  const docs = Object.fromEntries([
    ...RELEASE_DOCS.map((name) => [name, readFileSync(join(root, name))] as const),
    ...Object.entries(RELEASE_ASSETS).map(([name, source]) => [name, readFileSync(join(root, source))] as const),
  ]);
  const manifest: ReleaseManifest = { schema: 1, ...metadata, artifacts: [] };
  for (const artifact of artifacts) {
    const file = `tableau-ai-eval-${metadata.tag}-${artifact.target}.zip`;
    const zip = releaseZip(TARGETS[artifact.target].executable, readFileSync(artifact.path), docs);
    writeFileSync(join(directory, file), zip);
    manifest.artifacts.push({ target: artifact.target, file, sha256: sha256(zip) });
  }
  writeFileSync(join(directory, "SHA256SUMS"), checksumFile(manifest));
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest };
}

function checksumFile(manifest: ReleaseManifest): string {
  return manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}\n`).join("");
}

/** Validate external JSON before using any of its filenames in an upload. */
export function validateManifest(value: unknown, expected: { version: string; tag: string; commit: string }): ReleaseManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid release manifest.");
  const m = value as Partial<ReleaseManifest>;
  if (m.schema !== 1 || m.version !== expected.version || m.tag !== expected.tag || m.commit !== expected.commit || m.clean !== true) {
    throw new Error("Release manifest does not match the clean checkout's version and commit. Run bun release --all again.");
  }
  if (!Array.isArray(m.artifacts) || m.artifacts.length !== ALL_TARGETS.length) throw new Error("Release manifest must contain all supported targets. Run bun release --all.");
  const seen = new Set<Target>();
  for (const a of m.artifacts) {
    if (typeof a !== "object" || a === null || !ALL_TARGETS.includes(a.target) || seen.has(a.target) ||
      a.file !== `tableau-ai-eval-${expected.tag}-${a.target}.zip` || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256)) {
      throw new Error("Invalid release artifact in manifest.");
    }
    seen.add(a.target);
  }
  return m as ReleaseManifest;
}

export function verifyRelease(directory: string, expected: { version: string; tag: string; commit: string }): ReleaseManifest {
  const manifest = validateManifest(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")), expected);
  for (const artifact of manifest.artifacts) {
    if (sha256(readFileSync(join(directory, artifact.file))) !== artifact.sha256) throw new Error(`Checksum mismatch: ${artifact.file}. Rebuild the release.`);
  }
  if (readFileSync(join(directory, "SHA256SUMS"), "utf8") !== checksumFile(manifest)) throw new Error("SHA256SUMS does not match the release manifest.");
  return manifest;
}

async function checkout(run: CommandRunner): Promise<{ commit: string; clean: boolean }> {
  const commit = await command(run, ["git", "rev-parse", "HEAD"]);
  const status = await command(run, ["git", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
  const submodules = await command(run, ["git", "submodule", "status", "--recursive"]);
  // Uninitialized optional content is allowed; mismatched/conflicted submodules are not.
  const clean = status === "" && !submodules.split("\n").some((line) => /^[+U]/.test(line));
  return { commit, clean };
}

function validateHostname(value: string): string {
  if (value.length > 253 || !value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error("Invalid hostname. Use a host such as github.com, without a scheme, port, or path.");
  }
  return value.toLowerCase();
}

/** Resolve origin explicitly rather than relying on gh's preferred remote or GH_HOST. */
export function originDestination(origin: string, hostnameOverride?: string): { hostname: string; nameWithOwner: string } {
  let hostname: string;
  let path: string;
  if (/^(?:https?|ssh|git):\/\//i.test(origin)) {
    const url = new URL(origin);
    if (url.search || url.hash) throw new Error("Origin must be a repository URL without a query or fragment.");
    hostname = url.hostname;
    path = url.pathname.replace(/^\//, "");
  } else {
    const match = /^(?:[^@\s/:]+@)?([^\s/:]+):(.+)$/.exec(origin);
    if (!match) throw new Error("Cannot derive a GitHub destination from origin. Configure origin as an HTTPS or SSH repository URL.");
    hostname = match[1]!;
    path = match[2]!;
  }
  const nameWithOwner = path.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(nameWithOwner) || nameWithOwner.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Origin must identify a GitHub owner/repository path.");
  }
  return { hostname: validateHostname(hostnameOverride ?? hostname), nameWithOwner };
}

export async function publishPreflight(version: { version: string; tag: string }, run: CommandRunner = runCommand, hostnameOverride?: string): Promise<{ repo: string; commit: string }> {
  const tags = await command(run, ["git", "tag", "--list", version.tag]);
  if (tags.split("\n").includes(version.tag)) throw existingTag(version);
  const origin = await command(run, ["git", "remote", "get-url", "origin"]);
  const destination = originDestination(origin, hostnameOverride);
  const hostname = destination.hostname;
  const repo = `${hostname}/${destination.nameWithOwner}`;
  const api = ["gh", "api", "--hostname", hostname];
  const endpoint = `repos/${destination.nameWithOwner}`;
  await command(run, ["gh", "auth", "status", "--hostname", hostname]);
  const refs: unknown = JSON.parse(await command(run, [...api, `${endpoint}/git/matching-refs/tags/${version.tag}`]));
  if (!Array.isArray(refs)) throw new Error("Unexpected GitHub tag response.");
  if (refs.some((ref) => ref?.ref === `refs/tags/${version.tag}`)) throw existingTag(version);
  // Also reject an existing draft release without a tag.
  const releases = await command(run, [...api, "--paginate", `${endpoint}/releases`, "--jq", ".[].tag_name"]);
  if (releases.split("\n").includes(version.tag)) throw existingTag(version);
  const state = await checkout(run);
  if (!state.clean) throw new Error("Publishing requires a clean checkout, including submodules. Commit your version change and source changes first.");
  const remote = await run([...api, `${endpoint}/commits/${state.commit}`, "--jq", ".sha"]);
  if (remote.code !== 0 || remote.stdout !== state.commit) {
    throw new Error(`Could not verify commit ${state.commit} in ${repo}. Push the release commit to that repository before publishing and check GitHub access.${remote.stderr ? ` ${remote.stderr}` : ""}`);
  }
  return { repo, commit: state.commit };
}

function existingTag(version: { version: string; tag: string }): Error {
  return new Error(`Tag or release ${version.tag} already exists. Update the version in package.json (currently ${version.version}), commit and push it, then publish again. Existing releases are never overwritten.`);
}

export async function uploadRelease(
  repo: string, directory: string, manifest: ReleaseManifest, makePublic: boolean, run: CommandRunner = runCommand,
): Promise<void> {
  const files = [...manifest.artifacts.map((a) => join(directory, a.file)), join(directory, "SHA256SUMS"), join(directory, "manifest.json")];
  const args = ["gh", "release", "create", manifest.tag, ...files, "--repo", repo, "--target", manifest.commit,
    "--title", manifest.tag, "--generate-notes", "--draft"];
  if (manifest.version.split("+")[0]!.includes("-")) args.push("--prerelease");
  await command(run, args);
  if (makePublic) await command(run, ["gh", "release", "edit", manifest.tag, "--repo", repo, "--draft=false"]);
  console.log(`${makePublic ? "Published" : "Created draft"} ${manifest.tag} in ${repo}.`);
}

export async function releaseMain(args: string[], publish = false): Promise<void> {
  const opts = releaseOptions(args, publish);
  const version = releaseVersion();
  const destination = publish ? await publishPreflight(version, runCommand, opts.hostname) : undefined;
  const state = await checkout(runCommand);
  const targets = opts.all ? [...ALL_TARGETS] : [opts.target ?? nativeTarget()];
  let directory = join(ROOT, "dist", "releases", version.tag);
  if (!opts.noBuild) {
    const artifacts = await compileTargets(targets, !opts.all && !opts.target);
    const after = await checkout(runCommand);
    if (after.commit !== state.commit || (state.clean && !after.clean)) throw new Error("Checkout changed while building. Commit changes and rebuild before publishing.");
    directory = packageRelease(artifacts, { ...version, ...state }).directory;
    console.log(`Packaged release -> ${directory}`);
  }
  if (destination) {
    const manifest = verifyRelease(directory, { ...version, commit: destination.commit });
    // Catch source changes or a tag created during the build.
    const final = await publishPreflight(version, runCommand, opts.hostname);
    if (final.repo !== destination.repo || final.commit !== destination.commit || releaseVersion().version !== version.version) {
      throw new Error("Release source or destination changed. Rebuild before publishing.");
    }
    await uploadRelease(destination.repo, directory, manifest, opts.public);
  }
}

if (import.meta.main) {
  try { await releaseMain(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
