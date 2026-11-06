import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReleasePackage } from "./download.ts";
import { HYPER_RELEASE_INTEGRITY, HYPER_RELEASE_VERSION } from "./release.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(includeServer = true) {
  const cacheRoot = await mkdtemp(join(tmpdir(), "tableau-ai-eval-hyper-download-test-"));
  roots.push(cacheRoot);
  const contents: Record<string, string> = {
    "package/hyperdb-api-node.darwin-arm64.node": "fake native addon",
    "package/LICENSE-HYPERD": "license",
    "package/../../escape": "must never be extracted",
  };
  if (includeServer) contents["package/hyperd"] = "fake server";
  const bytes = Bun.gzipSync(await new Bun.Archive(contents).bytes());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  let calls = 0;
  const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
    expect(String(url)).toBe(`https://registry.npmjs.org/hyperdb-api-node-darwin-arm64/-/hyperdb-api-node-darwin-arm64-${HYPER_RELEASE_VERSION}.tgz`);
    calls++;
    return new Response(bytes);
  }) as typeof fetch;
  return { cacheRoot, integrity, fetchImpl, calls: () => calls };
}

test("verified package installs only required files; cache works offline", async () => {
  const opts = await fixture();
  const target = await ensureReleasePackage("darwin-arm64", opts);
  expect(await readFile(join(target, "hyperd"), "utf8")).toBe("fake server");
  expect((await readdir(target)).sort()).toEqual(["LICENSE-HYPERD", "hyperd", "hyperdb-api-node.darwin-arm64.node", "verified.json"]);
  expect(await ensureReleasePackage("darwin-arm64", opts)).toBe(target);
  expect(opts.calls()).toBe(1);
  expect(await readdir(opts.cacheRoot)).toEqual([HYPER_RELEASE_VERSION]);
});

test("modified cached executable is repaired with another verified download", async () => {
  const opts = await fixture();
  const target = await ensureReleasePackage("darwin-arm64", opts);
  await writeFile(join(target, "hyperd"), "corrupted");
  await ensureReleasePackage("darwin-arm64", opts);
  expect(opts.calls()).toBe(2);
  expect(await readFile(join(target, "hyperd"), "utf8")).toBe("fake server");
});

test("concurrent installers converge on one complete cache", async () => {
  const opts = await fixture();
  const [first, second] = await Promise.all([
    ensureReleasePackage("darwin-arm64", opts),
    ensureReleasePackage("darwin-arm64", opts),
  ]);
  expect(first).toBe(second);
  expect(await readFile(join(first, "hyperd"), "utf8")).toBe("fake server");
  expect(await readdir(join(opts.cacheRoot, HYPER_RELEASE_VERSION))).toEqual(["darwin-arm64"]);
});

test("integrity mismatch never installs and cleans staging files", async () => {
  const opts = await fixture();
  await expect(ensureReleasePackage("darwin-arm64", { ...opts, integrity: "sha512-wrong" })).rejects.toThrow("integrity check failed");
  expect(await readdir(join(opts.cacheRoot, HYPER_RELEASE_VERSION))).toEqual([]);
});

test("incomplete verified archive never installs", async () => {
  const opts = await fixture(false);
  await expect(ensureReleasePackage("darwin-arm64", opts)).rejects.toThrow("missing hyperd");
  expect(await readdir(join(opts.cacheRoot, HYPER_RELEASE_VERSION))).toEqual([]);
});

test("HTTP and network failures are actionable and can be retried", async () => {
  const opts = await fixture();
  const httpFail = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
  await expect(ensureReleasePackage("darwin-arm64", { ...opts, fetchImpl: httpFail })).rejects.toThrow("HTTP 503");
  const networkFail = (async () => { throw new Error("network unreachable"); }) as unknown as typeof fetch;
  await expect(ensureReleasePackage("darwin-arm64", { ...opts, fetchImpl: networkFail })).rejects.toThrow("Check internet access and write permission");
  expect(await ensureReleasePackage("darwin-arm64", opts)).toContain("darwin-arm64");
});

test("npm uses public trust even when a Tableau CA bundle is configured", async () => {
  const opts = await fixture();
  const requests: RequestInit[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(init ?? {});
    return opts.fetchImpl(url, init);
  }) as typeof fetch;
  await ensureReleasePackage("darwin-arm64", { ...opts, fetchImpl, caBundlePath: "/tableau-only-ca.pem" });
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty("tls");
});

test("certificate failure retries with the configured private CA and verification enabled", async () => {
  const opts = await fixture();
  const requests: RequestInit[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(init ?? {});
    if (requests.length === 1) throw new Error("unable to get local issuer certificate");
    return opts.fetchImpl(url, init);
  }) as typeof fetch;
  await ensureReleasePackage("darwin-arm64", { ...opts, fetchImpl, caBundlePath: "/corporate-ca.pem" });
  expect(requests).toHaveLength(2);
  expect(requests[0]).not.toHaveProperty("tls");
  expect(requests[1]).toHaveProperty("tls.ca");
  expect(requests[1]).not.toHaveProperty("tls.rejectUnauthorized", false);
});

test("non-certificate failures do not retry with a different trust store", async () => {
  const opts = await fixture();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("network unreachable");
  }) as unknown as typeof fetch;
  await expect(ensureReleasePackage("darwin-arm64", { ...opts, fetchImpl, caBundlePath: "/corporate-ca.pem" })).rejects.toThrow("network unreachable");
  expect(calls).toBe(1);
});

test("unresolved certificate failures give a TLS-specific hint in the publish error", async () => {
  const opts = await fixture();
  const fetchImpl = (async () => { throw new Error("unable to get local issuer certificate"); }) as unknown as typeof fetch;
  await expect(ensureReleasePackage("darwin-arm64", { ...opts, fetchImpl, caBundlePath: null })).rejects.toThrow("Configure TABLEAU_AI_EVAL_CA_BUNDLE");
});

test("unsupported platform fails without a download", async () => {
  await expect(ensureReleasePackage("linux-arm64-gnu")).rejects.toThrow("not available");
});

test("release integrity pins match the committed npm lockfile", async () => {
  const lock = await readFile(join(import.meta.dir, "../../../../bun.lock"), "utf8");
  for (const [tag, integrity] of Object.entries(HYPER_RELEASE_INTEGRITY)) {
    const line = lock.split("\n").find((l) => l.includes(`"hyperdb-api-node-${tag}": [`));
    expect(line).toContain(`@${HYPER_RELEASE_VERSION}`);
    expect(line).toContain(integrity);
  }
});
