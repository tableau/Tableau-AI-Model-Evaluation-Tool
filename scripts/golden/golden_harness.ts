/**
 * Shared helpers for the end-to-end record/replay parity golden
 * (goldens/e2e/). Used by
 * `replay_parity.ts` (offline, deterministic).
 *
 * Responsibilities:
 *   - pick the SMALL slice of calc cases to run (a handful only),
 *   - build the RunConfig that drives NlqHarnessRunner,
 *   - provide a SCRUBBING record/replay fetch seam. The scrubber removes any
 *     PAT secret / auth token / session token from both the recorded request
 *     bodies and the recorded response bytes BEFORE anything is written to
 *     disk, so the committed fixtures carry CES server data but NO secrets.
 *
 * The fixture key is method + url + normalized-body (identical hashing to
 * src/bridge/record_replay.ts). We reuse `computeKey`/`normalizeBody` from that
 * module so record and replay agree, and so a reference scorer can compute the
 * same key over the same request.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeKey, normalizeBody, type FetchLike } from "../../packages/server/src/bridge/record_replay.ts";
import type { RunConfig } from "@tableau-ai-eval/core";

// fileURLToPath (not URL.pathname): pathname yields `/C:/...` on Windows.
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const CASES_DIR = join(REPO_ROOT, "public-suites", "calcs", "cases", "kept-chicago-taxi");
export const FIXTURES_DIR = join(REPO_ROOT, "public-suites", "fixtures");
export const CES_FIXTURES_DIR = join(REPO_ROOT, "goldens", "e2e", "ces_fixtures");
export const METRICS_FILE = "metrics-calcs";

/**
 * The small, stable slice we capture/replay. Kept to a handful of cases per the
 * task (keep the live capture tiny). Ordered so ids are deterministic.
 */
export const SLICE_CASE_FILES = [
  "calcs_chicago-taxi_1.json",
  "calcs_chicago-taxi_2.json",
  "calcs_chicago-taxi_4.json",
  "calcs_chicago-taxi_6.json",
  "calcs_chicago-taxi_7.json",
];

/** Build the RunConfig for the calc slice. Credentials are threaded in. */
export function buildRunConfig(creds: {
  server: string;
  site: string;
  patName: string;
  patValue: string;
  verifyTls: boolean;
}): RunConfig {
  const cesUrl = `${creds.server.replace(/\/+$/, "")}/content-exploration`;
  return {
    test_path: CASES_DIR,
    fixtures_dir: FIXTURES_DIR,
    metrics_file: METRICS_FILE,
    ces_url: cesUrl,
    tableau_server: creds.server,
    tableau_site: creds.site,
    tableau_pat_name: creds.patName,
    tableau_pat_value: creds.patValue,
    verify_tls: creds.verifyTls,
  };
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/**
 * Replace every occurrence of each secret with a stable placeholder in a text
 * blob. Used to sanitize recorded request bodies and response bytes so no
 * secret is ever written to a committed fixture.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join("__SCRUBBED__");
    }
  }
  return out;
}

/** On-disk fixture shape (mirrors record_replay.ts Fixture, minus request headers). */
export interface E2EFixture {
  request: { method: string; url: string; normalizedBody: string };
  response: { status: number; statusText: string; body: string };
}

/**
 * A record/replay fetch that SCRUBS secrets before persisting. In record mode
 * it delegates to the real fetch, scrubs the request body + response body, and
 * writes `<key>.json`. In replay mode it reconstructs the Response from the
 * fixture. A replay miss is a loud error (no silent network fallthrough).
 *
 * `secrets` are the values (PAT secret, session token(s)) to remove. Because
 * the session token is minted at signin time, the caller registers it via
 * `registerSecret` as soon as it is known (the recorder also auto-scrubs the
 * `X-Tableau-Auth` header value it sees on outgoing requests).
 */
export function createScrubbingFetch(opts: {
  mode: "record" | "replay";
  dir: string;
  secrets: string[];
  delegate?: FetchLike;
  onKey?: (info: { key: string; method: string; url: string }) => void;
  /** Called after each request completes with the SCRUBBED bytes (record mode). */
  tap?: (info: { method: string; url: string; requestBody: string; responseBody: string }) => void;
}): { fetchImpl: FetchLike; registerSecret: (s: string) => void } {
  const secrets = [...opts.secrets];
  const delegate = opts.delegate ?? fetch;

  const registerSecret = (s: string) => {
    if (s && !secrets.includes(s)) secrets.push(s);
  };

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let bodyText = "";
    if (init?.body != null) bodyText = typeof init.body === "string" ? init.body : String(init.body);

    // Auto-register the session token carried in X-Tableau-Auth so it is
    // scrubbed from any response echo as well.
    const authHeader = headerValue(init?.headers, "x-tableau-auth");
    if (authHeader) registerSecret(authHeader);

    const key = computeKey(method, url, bodyText);
    opts.onKey?.({ key, method, url });
    const fixturePath = join(opts.dir, `${key}.json`);

    if (opts.mode === "replay") {
      let raw: string;
      try {
        raw = await readFile(fixturePath, "utf8");
      } catch (e) {
        throw new Error(
          `replay miss: no fixture at ${fixturePath} for ${method} ${url} (${e instanceof Error ? e.message : e})`,
        );
      }
      const fx = JSON.parse(raw) as E2EFixture;
      return reconstruct(fx);
    }

    // record: delegate, scrub, persist.
    const resp = await delegate(input, init);
    const respBody = await resp.clone().text();
    const scrubbedReqBody = scrubSecrets(normalizeBody(bodyText), secrets);
    const scrubbedRespBody = scrubSecrets(respBody, secrets);
    const fixture: E2EFixture = {
      request: { method, url, normalizedBody: scrubbedReqBody },
      response: { status: resp.status, statusText: resp.statusText, body: scrubbedRespBody },
    };
    await mkdir(opts.dir, { recursive: true });
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n", "utf8");
    opts.tap?.({ method, url, requestBody: scrubbedReqBody, responseBody: scrubbedRespBody });
    // Return a fresh Response so the caller's copy is unconsumed & scrubbed
    // (the session token echoed back — if any — is removed too).
    return reconstruct(fixture);
  }) as unknown as FetchLike;

  return { fetchImpl, registerSecret };
}

function reconstruct(fx: E2EFixture): Response {
  const nullBody = fx.response.status === 204 || fx.response.status === 304 || fx.response.status === 101;
  return new Response(nullBody ? null : fx.response.body, {
    status: fx.response.status,
    statusText: fx.response.statusText,
    headers: { "content-type": "application/json" },
  });
}

function headerValue(headers: RequestInit["headers"], name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) if (k.toLowerCase() === lower) return v;
    return null;
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return String(v);
  return null;
}

/** Stable hash of a normalized CES response body (used to correlate PY vs TS). */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/** List the captured fixture files (sorted). */
export async function listFixtures(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}
