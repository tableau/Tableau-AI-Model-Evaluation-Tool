import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { ALL_TARGETS, TARGETS, compileOptions, parseTarget } from "./build.ts";
import { originDestination, packageRelease, publishPreflight, releaseOptions, releaseVersion, releaseZip, uploadRelease, validateManifest, verifyRelease, type CommandRunner, type ReleaseManifest } from "./release.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tableau-ai-eval-release-test-"));
  dirs.push(dir);
  return dir;
}
const version = { version: "0.1.0", tag: "v0.1.0" };
const commit = "a".repeat(40);
const metadata = { ...version, commit, clean: true };

function packaged(): { directory: string; manifest: ReleaseManifest } {
  const root = temp();
  writeFileSync(join(root, "README.md"), "Release guide");
  writeFileSync(join(root, "LICENSE.txt"), "Release license");
  writeFileSync(join(root, "SECURITY.md"), "Security policy");
  mkdirSync(join(root, "packages/frontend/public"), { recursive: true });
  writeFileSync(join(root, "packages/frontend/public/logo512.png"), "logo bytes");
  writeFileSync(join(root, "SECRET.md"), "Do not package");
  const artifacts = ALL_TARGETS.map((target) => {
    const path = join(root, target);
    writeFileSync(path, `binary-${target}`);
    return { target, path };
  });
  return packageRelease(artifacts, metadata, root);
}

test("version and tag come exclusively from package.json", () => {
  const root = temp();
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.3.4-beta.1" }));
  expect(releaseVersion(root)).toEqual({ version: "2.3.4-beta.1", tag: "v2.3.4-beta.1" });
  for (const invalid of [undefined, 1, "../oops", "v1.0.0", "01.0.0", "1.0"]) {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: invalid }));
    expect(() => releaseVersion(root)).toThrow("valid release version");
  }
});

test("CLI defaults and supported targets are explicit", () => {
  expect(releaseOptions([], false)).toEqual({ all: false, noBuild: false, public: false });
  expect(releaseOptions([], true)).toEqual({ all: true, noBuild: false, public: false });
  expect(releaseOptions(["--no-build", "--public"], true)).toEqual({ all: true, noBuild: true, public: true });
  expect(releaseOptions(["--target", "linux-x64"], false).target).toBe("linux-x64");
  expect(compileOptions(["--all"]).targets).toEqual(ALL_TARGETS);
  expect(compileOptions(["--target", "windows-x64"])).toEqual({ targets: ["windows-x64"], nativeOutput: false });
  expect(TARGETS["linux-x64"].bun).toBe("bun-linux-x64-baseline");
  expect(TARGETS["windows-x64"].executable).toBe("tableau-ai-eval.exe");
  for (const args of [["--tag", "v1.0.0"], ["--public"], ["--no-build"], ["--all", "--target", "linux-x64"], ["--all", "--all"], ["--target"]]) {
    expect(() => releaseOptions(args, false)).toThrow();
  }
  expect(() => releaseOptions(["--target", "linux-x64"], true)).toThrow();
  expect(() => parseTarget("linux-arm64")).toThrow("Unsupported target");
  expect(() => parseTarget("toString")).toThrow("Unsupported target");
});

test("ZIP preserves contents and Unix executable mode", () => {
  const zip = releaseZip("tableau-ai-eval", Buffer.from("binary"), { "README.md": Buffer.from("guide") });
  const files = unzipSync(zip);
  expect(Object.keys(files)).toEqual(["tableau-ai-eval", "README.md"]);
  expect(Buffer.from(files["tableau-ai-eval"]!).toString()).toBe("binary");
  const buf = Buffer.from(zip);
  const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  expect(central).toBeGreaterThan(0);
  expect(buf[central + 5]).toBe(3); // made by Unix
  expect(buf.readUInt32LE(central + 38) >>> 16).toBe(0o100755);
});

test("packaging allowlists README, LICENSE, SECURITY and the logo, separates targets, and records matching checksums", () => {
  const { directory, manifest } = packaged();
  expect(verifyRelease(directory, metadata)).toEqual(manifest);
  for (const artifact of manifest.artifacts) {
    const files = unzipSync(readFileSync(join(directory, artifact.file)));
    expect(Object.keys(files)).toEqual([TARGETS[artifact.target].executable, "README.md", "LICENSE.txt", "SECURITY.md", "tableau-ai-eval-logo.png"]);
    expect(Buffer.from(files["README.md"]!).toString()).toBe("Release guide");
    expect(Buffer.from(files["tableau-ai-eval-logo.png"]!).toString()).toBe("logo bytes");
    expect(Buffer.from(files["LICENSE.txt"]!).toString()).toBe("Release license");
    expect(Buffer.from(files["SECURITY.md"]!).toString()).toBe("Security policy");
  }
  writeFileSync(join(directory, "stale.zip"), "ignored");
  expect(verifyRelease(directory, metadata).artifacts.length).toBe(3);
  writeFileSync(join(directory, manifest.artifacts[0]!.file), "corrupt");
  expect(() => verifyRelease(directory, metadata)).toThrow("Checksum mismatch");
});

test("no-build rejects wrong source, dirty builds, incomplete manifests and unsafe filenames", () => {
  const { directory, manifest } = packaged();
  expect(() => validateManifest(null, metadata)).toThrow();
  expect(() => validateManifest(manifest, { ...metadata, commit: "b".repeat(40) })).toThrow("does not match");
  expect(() => validateManifest({ ...manifest, clean: false }, metadata)).toThrow("does not match");
  expect(() => validateManifest({ ...manifest, artifacts: manifest.artifacts.slice(1) }, metadata)).toThrow("all supported targets");
  for (const change of [{ file: "../../evil.zip" }, { target: "__proto__" }, { sha256: "oops" }]) {
    const artifacts = manifest.artifacts.map((a, i) => i === 0 ? { ...a, ...change } : a);
    expect(() => validateManifest({ ...manifest, artifacts }, metadata)).toThrow("Invalid release artifact");
  }
  expect(() => validateManifest({ ...manifest, artifacts: [manifest.artifacts[0], manifest.artifacts[0], manifest.artifacts[2]] }, metadata)).toThrow();
  writeFileSync(join(directory, "SHA256SUMS"), "incorrect");
  expect(() => verifyRelease(directory, metadata)).toThrow("SHA256SUMS");
});

function fakeRun(overrides: Record<string, string | number | undefined> = {}): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const defaults: Record<string, string> = {
    "git tag --list v0.1.0": "",
    "gh auth status --hostname github.com": "Authenticated",
    "git remote get-url origin": "git@github.com:owner/tableau-ai-eval.git",
    "gh api --hostname github.com repos/owner/tableau-ai-eval/git/matching-refs/tags/v0.1.0": "[]",
    "gh api --hostname github.com --paginate repos/owner/tableau-ai-eval/releases --jq .[].tag_name": "",
    "git rev-parse HEAD": commit,
    "git status --porcelain --untracked-files=all --ignore-submodules=none": "",
    "git submodule status --recursive": "",
    [`gh api --hostname github.com repos/owner/tableau-ai-eval/commits/${commit} --jq .sha`]: commit,
  };
  const run: CommandRunner = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (!(key in defaults) && !(key in overrides) && !key.startsWith("gh release ")) throw new Error(`Unexpected command: ${key}`);
    const result = overrides[key] ?? defaults[key] ?? "";
    return typeof result === "number" ? { code: result, stdout: "", stderr: "failure" } : { code: 0, stdout: result, stderr: "" };
  };
  return { run, calls };
}

test("publish preflight rejects local or remote exact tag with version-bump guidance", async () => {
  for (const overrides of [
    { "git tag --list v0.1.0": "v0.1.0" },
    { "gh api --hostname github.com repos/owner/tableau-ai-eval/git/matching-refs/tags/v0.1.0": '[{"ref":"refs/tags/v0.1.0"}]' },
    { "gh api --hostname github.com --paginate repos/owner/tableau-ai-eval/releases --jq .[].tag_name": "v0.1.0" },
  ]) {
    const { run, calls } = fakeRun(overrides);
    await expect(publishPreflight(version, run)).rejects.toThrow("Update the version in package.json");
    expect(calls.some((args) => args.includes("create"))).toBe(false);
  }
  const { run } = fakeRun({ "gh api --hostname github.com repos/owner/tableau-ai-eval/git/matching-refs/tags/v0.1.0": '[{"ref":"refs/tags/v0.1.01"}]' });
  expect(await publishPreflight(version, run)).toEqual({ repo: "github.com/owner/tableau-ai-eval", commit });
});

test("publishing fails closed on GitHub errors, dirty checkout or mismatched submodules", async () => {
  for (const overrides of [
    { "gh auth status --hostname github.com": 1 },
    { "gh api --hostname github.com repos/owner/tableau-ai-eval/git/matching-refs/tags/v0.1.0": 1 },
    { "git status --porcelain --untracked-files=all --ignore-submodules=none": " M package.json" },
    { "git submodule status --recursive": `+${commit} extra-content` },
    { [`gh api --hostname github.com repos/owner/tableau-ai-eval/commits/${commit} --jq .sha`]: 1 },
  ]) {
    await expect(publishPreflight(version, fakeRun(overrides).run)).rejects.toThrow();
  }
});

test("Enterprise preflight and upload consistently use the resolved host", async () => {
  const hostname = "git.example.com";
  const fake = fakeRun({
    "git remote get-url origin": `git@${hostname}:owner/tableau-ai-eval.git`,
  });
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push(args);
    // Reuse the public-host responses, but assert Enterprise arguments first.
    if (args[0] === "gh" && ["api", "auth"].includes(args[1]!)) {
      expect(args[args.indexOf("--hostname") + 1]).toBe(hostname);
    }
    return fake.run(args.map((arg) => arg === hostname ? "github.com" : arg));
  };
  const destination = await publishPreflight(version, run);
  expect(destination).toEqual({ repo: "git.example.com/owner/tableau-ai-eval", commit });
  const { directory, manifest } = packaged();
  await uploadRelease(destination.repo, directory, manifest, true, run);
  for (const args of calls.filter((args) => args[1] === "release")) {
    expect(args[args.indexOf("--repo") + 1]).toBe("git.example.com/owner/tableau-ai-eval");
  }
});

test("API errors identify the endpoint and hostname rather than swallowing 404", async () => {
  const fake = fakeRun({ "gh api --hostname github.com repos/owner/tableau-ai-eval/git/matching-refs/tags/v0.1.0": 1 });
  await expect(publishPreflight(version, fake.run)).rejects.toThrow("gh api --hostname github.com repos/owner/tableau-ai-eval/git/matching-refs/tags/v0.1.0 failed");
});

test("origin resolution supports HTTPS, SSH URL and scp-style remotes", () => {
  for (const origin of [
    "https://git.example.com/owner/tableau-ai-eval.git",
    "https://user@git.example.com/owner/tableau-ai-eval/",
    "ssh://git@git.example.com:2222/owner/tableau-ai-eval.git",
    "git@git.example.com:owner/tableau-ai-eval.git",
    "git.example.com:owner/tableau-ai-eval.git",
  ]) {
    expect(originDestination(origin)).toEqual({ hostname: "git.example.com", nameWithOwner: "owner/tableau-ai-eval" });
    expect(originDestination(origin, "GITHUB.COM")).toEqual({ hostname: "github.com", nameWithOwner: "owner/tableau-ai-eval" });
  }
  for (const origin of ["/local/repo", "file:///local/repo", "https://github.com/owner/repo/extra", "git@github.com:../repo.git"]) {
    expect(() => originDestination(origin)).toThrow();
  }
  for (const hostname of ["https://github.com", "github.com/repo", "github.com:443", "--hostname", "", "bad..host"]) {
    expect(() => originDestination("git@github.com:owner/repo.git", hostname)).toThrow("Invalid hostname");
  }
});

test("hostname override is publish-only and applies to every preflight API request", async () => {
  expect(releaseOptions(["--hostname", "git.example.com"], true).hostname).toBe("git.example.com");
  expect(() => releaseOptions(["--hostname", "git.example.com"], false)).toThrow();
  expect(() => releaseOptions(["--hostname"], true)).toThrow();
  const fake = fakeRun({ "git remote get-url origin": "git@git.example.com:owner/tableau-ai-eval.git" });
  const destination = await publishPreflight(version, fake.run, "github.com");
  expect(destination.repo).toBe("github.com/owner/tableau-ai-eval");
  expect(fake.calls.filter((args) => args[0] === "gh").every((args) => args[args.indexOf("--hostname") + 1] === "github.com")).toBe(true);
});

test("upload uses only manifest assets, creates draft at exact commit, and public is explicit", async () => {
  const { directory, manifest } = packaged();
  const draft = fakeRun();
  await uploadRelease("owner/tableau-ai-eval", directory, manifest, false, draft.run);
  expect(draft.calls.length).toBe(1);
  const args = draft.calls[0]!;
  expect(args.slice(0, 4)).toEqual(["gh", "release", "create", "v0.1.0"]);
  expect(args).toContain("--draft");
  expect(args[args.indexOf("--target") + 1]).toBe(commit);
  expect(args.filter((arg) => arg.endsWith(".zip")).length).toBe(3);
  const published = fakeRun();
  await uploadRelease("owner/tableau-ai-eval", directory, { ...manifest, version: "0.1.0-beta.1" }, true, published.run);
  expect(published.calls[0]).toContain("--prerelease");
  expect(published.calls[1]).toEqual(["gh", "release", "edit", "v0.1.0", "--repo", "owner/tableau-ai-eval", "--draft=false"]);
});

test("failed draft upload never proceeds to public publication", async () => {
  const { directory, manifest } = packaged();
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => { calls.push(args); return { code: 1, stdout: "", stderr: "upload failed" }; };
  await expect(uploadRelease("owner/tableau-ai-eval", directory, manifest, true, run)).rejects.toThrow("upload failed");
  expect(calls.length).toBe(1);
});
