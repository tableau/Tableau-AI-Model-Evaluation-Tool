import { test, expect, afterEach } from "bun:test";
import { rm, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRecordReplayFetch,
  computeKey,
  normalizeBody,
  ReplayMissError,
} from "./record_replay.ts";

const tmpDirs: string[] = [];
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rr-bridge-"));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

/** A delegate fetch returning a canned JSON response and counting calls. */
function countingDelegate(bodyObj: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(bodyObj), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("record then replay round-trip returns the recorded response offline", async () => {
  const dir = await freshDir();
  const { fn: delegate, calls } = countingDelegate({ answer: 42 });

  const recorder = createRecordReplayFetch({
    mode: "record",
    fixturesDir: dir,
    delegate,
  });
  const recResp = await recorder("https://api.example.com/x", {
    method: "POST",
    body: JSON.stringify({ a: 1, b: 2 }),
  });
  expect(recResp.status).toBe(200);
  expect(await recResp.json()).toEqual({ answer: 42 });
  expect(calls.length).toBe(1);

  // Fixture written.
  const files = await readdir(dir);
  expect(files.length).toBe(1);
  expect(files[0]!.endsWith(".json")).toBe(true);

  // Replay: delegate must NOT be called; response reconstructed from disk.
  const throwingDelegate = (async () => {
    throw new Error("network should not be touched in replay");
  }) as unknown as typeof fetch;
  const replayer = createRecordReplayFetch({
    mode: "replay",
    fixturesDir: dir,
    delegate: throwingDelegate,
  });
  const repResp = await replayer("https://api.example.com/x", {
    method: "POST",
    body: JSON.stringify({ a: 1, b: 2 }),
  });
  expect(repResp.status).toBe(200);
  expect(await repResp.json()).toEqual({ answer: 42 });
});

test("replay miss raises an explicit ReplayMissError", async () => {
  const dir = await freshDir();
  const replayer = createRecordReplayFetch({ mode: "replay", fixturesDir: dir });

  let err: unknown;
  try {
    await replayer("https://api.example.com/missing", {
      method: "POST",
      body: JSON.stringify({ nope: true }),
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ReplayMissError);
  expect((err as ReplayMissError).message).toContain("replay miss for key");
});

test("key is stable across body key-ordering (bodies are normalized)", () => {
  const k1 = computeKey("POST", "https://x/y", JSON.stringify({ a: 1, b: 2 }));
  const k2 = computeKey("POST", "https://x/y", JSON.stringify({ b: 2, a: 1 }));
  expect(k1).toBe(k2);

  // Nested objects also normalized.
  const n1 = computeKey("POST", "https://x/y", JSON.stringify({ o: { p: 1, q: 2 } }));
  const n2 = computeKey("POST", "https://x/y", JSON.stringify({ o: { q: 2, p: 1 } }));
  expect(n1).toBe(n2);
});

test("key differs for different method, url, or payload", () => {
  const base = computeKey("POST", "https://x/y", JSON.stringify({ a: 1 }));
  expect(computeKey("GET", "https://x/y", JSON.stringify({ a: 1 }))).not.toBe(base);
  expect(computeKey("POST", "https://x/z", JSON.stringify({ a: 1 }))).not.toBe(base);
  expect(computeKey("POST", "https://x/y", JSON.stringify({ a: 2 }))).not.toBe(base);
});

test("array order is preserved in normalization (semantically meaningful)", () => {
  const a = normalizeBody(JSON.stringify({ list: [1, 2, 3] }));
  const b = normalizeBody(JSON.stringify({ list: [3, 2, 1] }));
  expect(a).not.toBe(b);
});

test("method is upper-cased and reused across replay matching", async () => {
  const dir = await freshDir();
  const { fn: delegate } = countingDelegate({ ok: true });
  const recorder = createRecordReplayFetch({ mode: "record", fixturesDir: dir, delegate });
  await recorder("https://api.example.com/x", { method: "post", body: "{}" });

  const replayer = createRecordReplayFetch({ mode: "replay", fixturesDir: dir });
  // Uppercase method matches the recorded lowercase (normalized).
  const resp = await replayer("https://api.example.com/x", { method: "POST", body: "{}" });
  expect(await resp.json()).toEqual({ ok: true });
});

test("non-JSON body is used verbatim (not normalized)", () => {
  const k1 = computeKey("POST", "https://x/y", "raw-text-body");
  const k2 = computeKey("POST", "https://x/y", "raw-text-body");
  const k3 = computeKey("POST", "https://x/y", "different-raw");
  expect(k1).toBe(k2);
  expect(k1).not.toBe(k3);
  expect(normalizeBody("raw-text-body")).toBe("raw-text-body");
});
