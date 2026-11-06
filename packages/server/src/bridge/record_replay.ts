/**
 * Record/replay fetch seam for bridge egress.
 *
 * A record/replay fixture layer for the CES bridge keeps golden runs
 * independent of live model nondeterminism. This `fetch`-shaped wrapper is injectable into
 * `ces.ts` via its `fetchImpl` parameter.
 *
 * Modes:
 *  - `"record"`  — pass through to a real (delegate) fetch, then persist
 *                  `{ key -> serialized response }` to a fixtures directory.
 *  - `"replay"`  — look the key up in the fixtures dir and reconstruct the
 *                  Response; a miss is an explicit, loud error (no silent
 *                  network fallthrough).
 *  - `"passthrough"` — just delegate (a convenience for wiring the same seam
 *                  when neither recording nor replaying is desired).
 *
 * ## Request key
 *
 * The key is a stable SHA-256 hex digest of a canonical string:
 *
 *     `${METHOD}\n${url}\n${normalizedBody}`
 *
 * where METHOD is upper-cased, the url is used verbatim, and the body is
 * normalized (see below). This means the same logical request produces the
 * same fixture filename (`<key>.json`) regardless of process run.
 *
 * ## Body normalization
 *
 * We DO normalize JSON request bodies so that key-ordering differences in the
 * outgoing JSON do not change the key. A body is normalized by:
 *   1. attempting `JSON.parse`, then re-serializing with keys sorted
 *      recursively (stable stringify), OR
 *   2. if it is not valid JSON, using the raw string verbatim.
 * Arrays keep their order (order is semantically meaningful); only object keys
 * are sorted. This makes the key robust to serializer key-ordering while still
 * distinguishing genuinely different payloads. Empty/absent bodies normalize to
 * the empty string.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FetchLike = typeof fetch;

export type RecordReplayMode = "record" | "replay" | "passthrough";

export interface RecordReplayOptions {
  mode: RecordReplayMode;
  /** Where fixtures are read/written. Default: `fixtures/bridge/`. */
  fixturesDir?: string;
  /** The real fetch used in record/passthrough modes (default: global). */
  delegate?: FetchLike;
}

/** A miss during replay — surfaced loudly rather than falling through. */
export class ReplayMissError extends Error {
  readonly key: string;
  constructor(key: string, detail: string) {
    super(`replay miss for key ${key}: ${detail}`);
    this.name = "ReplayMissError";
    this.key = key;
  }
}

/** On-disk fixture shape. Body stored as text (UTF-8). */
interface Fixture {
  /** For human debuggability — not used for matching. */
  request: {
    method: string;
    url: string;
    normalizedBody: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
    body: string;
  };
}

const DEFAULT_FIXTURES_DIR = "fixtures/bridge/";

/** Recursively sort object keys; arrays keep order. Non-objects pass through. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Normalize a request body to a canonical string.
 * JSON → stable (key-sorted) re-serialization; non-JSON → raw; empty → "".
 */
export function normalizeBody(body: string | null | undefined): string {
  if (body === null || body === undefined || body === "") {
    return "";
  }
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(sortKeys(parsed));
  } catch {
    return body;
  }
}

/** Compute the stable request key from method + url + normalized body. */
export function computeKey(
  method: string,
  url: string,
  body: string | null | undefined,
): string {
  const canonical = `${method.toUpperCase()}\n${url}\n${normalizeBody(body)}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Extract a request body as text from fetch args, without consuming a stream twice. */
async function bodyToText(
  input: Parameters<FetchLike>[0],
  init?: RequestInit,
): Promise<string> {
  // If init.body is present, prefer it (that is what egpt/ces pass).
  if (init && init.body !== undefined && init.body !== null) {
    const b = init.body;
    if (typeof b === "string") {
      return b;
    }
    if (b instanceof URLSearchParams) {
      return b.toString();
    }
    if (b instanceof ArrayBuffer) {
      return Buffer.from(b).toString("utf8");
    }
    if (ArrayBuffer.isView(b)) {
      return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
    }
    // Fallback: best-effort stringify.
    return String(b);
  }
  // A Request object may carry the body.
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return "";
    }
  }
  return "";
}

function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function methodOf(
  input: Parameters<FetchLike>[0],
  init?: RequestInit,
): string {
  if (init?.method) {
    return init.method;
  }
  if (input instanceof Request) {
    return input.method;
  }
  return "GET";
}

async function serializeResponse(resp: Response): Promise<Fixture["response"]> {
  const clone = resp.clone();
  const body = await clone.text();
  const headers: Array<[string, string]> = [];
  resp.headers.forEach((v, k) => headers.push([k, v]));
  return {
    status: resp.status,
    statusText: resp.statusText,
    headers,
    body,
  };
}

function deserializeResponse(r: Fixture["response"]): Response {
  // `Response` rejects a body for 204/304 and other null-body statuses.
  const nullBody = r.status === 204 || r.status === 304 || r.status === 101;
  return new Response(nullBody ? null : r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
  });
}

/**
 * Build a `fetch`-compatible function that records or replays through fixtures.
 * Inject the returned function as `fetchImpl` into the bridges.
 */
export function createRecordReplayFetch(opts: RecordReplayOptions): FetchLike {
  const mode = opts.mode;
  const dir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const delegate = opts.delegate ?? fetch;

  const wrapped = async (
    input: Parameters<FetchLike>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    if (mode === "passthrough") {
      return delegate(input, init);
    }

    const url = urlOf(input);
    const method = methodOf(input, init);
    const bodyText = await bodyToText(input, init);
    const key = computeKey(method, url, bodyText);
    const fixturePath = join(dir, `${key}.json`);

    if (mode === "replay") {
      let raw: string;
      try {
        raw = await readFile(fixturePath, "utf8");
      } catch (exc) {
        const detail = exc instanceof Error ? exc.message : String(exc);
        throw new ReplayMissError(
          key,
          `no fixture at ${fixturePath} for ${method} ${url} (${detail})`,
        );
      }
      let fixture: Fixture;
      try {
        fixture = JSON.parse(raw) as Fixture;
      } catch (exc) {
        const detail = exc instanceof Error ? exc.message : String(exc);
        throw new ReplayMissError(key, `corrupt fixture ${fixturePath}: ${detail}`);
      }
      return deserializeResponse(fixture.response);
    }

    // record: pass through, then persist.
    const resp = await delegate(input, init);
    const fixture: Fixture = {
      request: { method: method.toUpperCase(), url, normalizedBody: normalizeBody(bodyText) },
      response: await serializeResponse(resp),
    };
    await mkdir(dir, { recursive: true });
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
    // Return a fresh Response so the caller's copy is unconsumed.
    return deserializeResponse(fixture.response);
  };

  return wrapped as unknown as FetchLike;
}
