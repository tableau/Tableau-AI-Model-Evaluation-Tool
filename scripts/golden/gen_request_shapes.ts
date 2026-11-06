/**
 * Request-shape goldens for the evaluation runners (OFFLINE, DETERMINISTIC).
 *
 * WHY THIS GOLDEN EXISTS
 * ----------------------
 * A model-backed eval has three separable layers (see goldens/request_shapes/
 * README.md):
 *   1. what we SEND to the runner (URL, method, headers-shape, request body) —
 *      a pure function of the test case + config, fully DETERMINISTIC,
 *   2. how we SCORE a fixed response with the deterministic metrics — needs one
 *      recorded response (the goldens/e2e/ record→replay slice), and
 *   3. the model's REPLY itself + any LLM-scored/judge metric — inherently
 *      NON-deterministic, not golden-able.
 *
 * This file pins layer 1 for the recorded request builders.
 * Dispatch uses `config.adapter`, NOT the runner name. The recorded contracts
 * use TWO builders:
 *   - `nlq` → NlqHarnessRunner → POST /analytics-assistant/conversations
 *     (used by ect-server, multistep-plan, calc-prompt, color-palettes-server,
 *      dashboard-viz-narrative-config — the runner name only picks the metrics
 *      config, never the request shape),
 *   - `cabu`         → TabCabuServiceClient → 3-phase POST/POST/GET
 *     .../analytics-assistant/cabu/conversations[/…].
 *
 * It drives the REAL runner code with a recording fetch that returns a canned
 * minimal reply (no network, no credentials), captures each outgoing request,
 * normalizes it, and writes goldens/request_shapes/<name>.json. The companion
 * test (request_shapes.test.ts) re-runs the identical generation and asserts
 * byte-equality, so a change to any request builder trips the test.
 *
 * Regenerate (offline, repeatable):
 *   $HOME/.bun/bin/bun run scripts/golden/gen_request_shapes.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NlqHarnessRunner,
  RateLimiter,
  TabCabuServiceClient,
  type HarnessCase,
} from "@tableau-ai-eval/evals";
import type { FetchLike, RunConfig } from "@tableau-ai-eval/core";
import { REPO_ROOT } from "./golden_harness.ts";

export const REQUEST_SHAPES_DIR = join(REPO_ROOT, "goldens", "request_shapes");

// ---------------------------------------------------------------------------
// Recording fetch: capture every outgoing request in a normalized shape, and
// reply with a canned minimal body selected per-URL. No network, no secrets.
// ---------------------------------------------------------------------------

/** One captured outbound request, normalized for a stable golden. */
export interface CapturedRequest {
  method: string;
  /** URL with the host stripped so the golden is host-independent. */
  pathAndQuery: string;
  /** Sorted header names present (values are auth/host dependent, so omitted). */
  headerNames: string[];
  /** Parsed JSON body, or the raw string when not JSON, or null when absent. */
  body: unknown;
}

function pathAndQueryOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function headerNamesOf(headers: RequestInit["headers"]): string[] {
  const names: string[] = [];
  if (!headers) return names;
  if (headers instanceof Headers) {
    headers.forEach((_v, k) => names.push(k));
  } else if (Array.isArray(headers)) {
    for (const [k] of headers) names.push(k);
  } else {
    for (const k of Object.keys(headers)) names.push(k);
  }
  return names.map((n) => n.toLowerCase()).sort();
}

function parseBody(body: unknown): unknown {
  if (body == null) return null;
  const text = typeof body === "string" ? body : String(body);
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A recording fetch that returns `replyFor(url)` and captures the request. */
function recordingFetch(
  captured: CapturedRequest[],
  replyFor: (url: string) => Response,
): FetchLike {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    captured.push({
      method,
      pathAndQuery: pathAndQueryOf(url),
      headerNames: headerNamesOf(init?.headers),
      body: parseBody(init?.body),
    });
    return replyFor(url);
  }) as unknown as FetchLike;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noWaitLimiter = () => new RateLimiter({ rate: 1_000_000, windowMs: 1 });

// ---------------------------------------------------------------------------
// Canned minimal responses (only enough for the builder to proceed; the REPLY
// content is irrelevant to a request-shape golden and is intentionally trivial).
// ---------------------------------------------------------------------------

function cesConversationReply(): Response {
  return json({
    intentApplicationDetection: {
      intent: "NLQ_TO_NEW_CALCULATED_FIELD",
      result: {
        status: "OK",
        calculatedFieldFormula: { formula: "SUM([x])", caption: "c", type: "" },
        colorPalette: ["#000000", "#ffffff"],
        _context: null,
      },
    },
    response: { content: "ok" },
  });
}

function cesReplyFor(url: string): Response {
  if (url.endsWith("/analytics-assistant/datasources")) {
    return json({ datasourceECTId: "ect-golden" });
  }
  if (url.includes("/datasources/") && url.endsWith("/fields")) {
    return json({});
  }
  if (url.endsWith("/analytics-assistant/color-palettes/generate")) {
    return json({ colors: ["#000000", "#ffffff"] });
  }
  return cesConversationReply();
}

// ---------------------------------------------------------------------------
// Generators, one per request builder. Each returns the captured requests.
// ---------------------------------------------------------------------------

/** NLQ: a calc case WITH a datasource (drives prepare() + convo). */
async function genNlqCalcWithDatasource(): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const runner = new NlqHarnessRunner({
    fetchImpl: recordingFetch(captured, cesReplyFor),
    rateLimiter: noWaitLimiter(),
    // Deterministic, offline datasource fixtures (no disk read).
    loadDatasource: () => ({
      fields: [{ caption: "Amount", datatype: "real" }],
    }),
    loadDatasourceMetadata: () => ({
      datasourceIdentifier: "public-activity-360",
      name: "Activity 360",
      fields: [
        {
          name: "Amount",
          caption: "Amount",
          datatype: "real",
          values: [1, 2, 3],
        },
      ],
    }),
    sessionFactory: () => null, // offline: no signin
  });
  const testCase: HarnessCase = {
    id: "calcs-golden-1",
    runner: "ect-server",
    datasource: "public-activity-360",
    utterance: "create a calc for total amount",
    turn: 0,
    expected: {
      intent: "NLQ_TO_NEW_CALCULATED_FIELD",
      calculatedFieldFormula: { formula: "SUM([Amount])", caption: null },
    },
  };
  await runner.runCase(testCase, nlqConfig(), []);
  return captured;
}

/** NLQ: a color-palette case → the palette generate endpoint. */
async function genNlqPalette(): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const runner = new NlqHarnessRunner({
    fetchImpl: recordingFetch(captured, cesReplyFor),
    rateLimiter: noWaitLimiter(),
    sessionFactory: () => null,
  });
  const testCase: HarnessCase = {
    id: "color-palette-golden-1",
    runner: "color-palettes-server",
    datasource: null,
    utterance: "temperature",
    turn: 0,
    // The color-palettes-server runner posts {utterance, paletteType} to the
    // Palette generate endpoint — a distinct request
    // path from the CES /conversations flow.
    expected: { colorPalette: [] },
    paletteType: "diverging",
  };
  await runner.runCase(testCase, nlqConfig(), []);
  return captured;
}

/** NLQ: a multistep-plan case (NO datasource → convo only). */
async function genNlqMultistep(): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const runner = new NlqHarnessRunner({
    fetchImpl: recordingFetch(captured, cesReplyFor),
    rateLimiter: noWaitLimiter(),
    sessionFactory: () => null,
  });
  const testCase: HarnessCase = {
    id: "multistep-plan-golden-1",
    runner: "multistep-plan",
    datasource: null,
    utterance: "show a plan",
    turn: 0,
    expected: { intent: "NLQ_TO_PLAN", steps: [] },
  };
  await runner.runCase(testCase, nlqConfig(), []);
  return captured;
}

function nlqConfig(): RunConfig {
  return {
    test_path: "/unused",
    ces_url: "https://ces.example.com/content-exploration",
    verify_tls: false,
  };
}

/** cabu: the three-phase conversation (create → utterance → stream). */
async function genCabu(): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const replyFor = (url: string): Response => {
    if (url.endsWith("/conversations")) {
      return json({ conversationId: "conv-golden", scope: "sc", sdmNames: ["sdm1"] });
    }
    if (url.endsWith("/utterances")) {
      return json({ utteranceId: "utt-golden", b3TraceId: "b3-golden" });
    }
    if (url.endsWith("/stream")) {
      return new Response(
        [
          "event: classification_complete",
          'data: {"utteranceType":"DATA_QUESTION"}',
          "",
          "event: response_complete",
          'data: {"response":"ok","chatLuid":"chat1","datatables":[]}',
          "",
          "event: complete",
          "data: {}",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response("nf", { status: 404 });
  };
  let n = 0;
  const client = new TabCabuServiceClient({
    baseUrl: "https://cabu.example.com",
    fetchImpl: recordingFetch(captured, replyFor),
    // Deterministic trace ids so the golden is stable.
    uuidHex: () => `traceid${String(++n).padStart(8, "0")}`,
    sslVerify: false,
  });
  client.parentLuid = "parent-golden";
  await client.createConversation({
    dashboardDatasources: [{ datasourceLuid: "ds-golden", name: "Superstore" }],
    workbookLuid: "wb-golden",
    sessionId: "",
  });
  await client.postUtterance({ utterance: "what are the top products?" });
  await client.streamConversation();
  return captured;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RequestShapeGolden {
  /** Human-facing description of what this slice covers. */
  description: string;
  /** The adapter/dispatch key. */
  adapter: "nlq" | "prep" | "cabu";
  /** Runner contracts covered by this request builder. */
  covers: string[];
  requests: CapturedRequest[];
}

export async function buildGoldens(): Promise<Record<string, RequestShapeGolden>> {
  return {
    nlq_calc_with_datasource: {
      description:
        "nlq calc case with a datasource: prepare() indexes the " +
        "datasource (POST /datasources + /fields) then POST /conversations.",
      adapter: "nlq",
      covers: ["ect-server (calcs, testbench, sample-testbench, nvbench)"],
      requests: await genNlqCalcWithDatasource(),
    },
    nlq_palette: {
      description:
        "nlq color-palette case: POST {utterance, paletteType} to " +
        "/analytics-assistant/color-palettes/generate; " +
        "the {colors} reply maps to {colorPalette} for scoring.",
      adapter: "nlq",
      covers: ["color-palettes-server (color-palette)"],
      requests: await genNlqPalette(),
    },
    nlq_multistep: {
      description:
        "nlq multistep-plan case (no datasource): identical " +
        "/conversations request shape; runner name only selects metrics-plan.",
      adapter: "nlq",
      covers: ["multistep-plan (multistep-plan)", "dashboard-viz-narrative-config"],
      requests: await genNlqMultistep(),
    },
    cabu_three_phase: {
      description:
        "cabu dashboard-QA: 3-phase POST create-conversation → POST utterance " +
        "→ GET stream, all under /analytics-assistant/cabu/conversations.",
      adapter: "cabu",
      covers: ["cabu-dashboard-qa (dashboard-qa-*, cabu-multi-turn-smoke)"],
      requests: await genCabu(),
    },
  };
}

async function main(): Promise<void> {
  const goldens = await buildGoldens();
  await mkdir(REQUEST_SHAPES_DIR, { recursive: true });
  for (const [name, golden] of Object.entries(goldens)) {
    const path = join(REQUEST_SHAPES_DIR, `${name}.json`);
    await writeFile(path, JSON.stringify(golden, null, 2) + "\n", "utf8");
    console.log(
      `wrote ${name}.json (${golden.requests.length} request(s), adapter=${golden.adapter})`,
    );
  }
  console.log(`\nRequest-shape goldens → ${REQUEST_SHAPES_DIR}`);
}

if (import.meta.main) {
  await main();
}
