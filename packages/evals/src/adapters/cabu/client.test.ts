import { describe, expect, test } from "bun:test";
import {
  TabCabuServiceClient,
  buildLoginXml,
  parseLoginXml,
  buildCreateConversationBody,
  buildPostUtteranceBody,
  parseCreateConversationResponse,
  parsePostUtteranceResponse,
  parseSseStream,
  coerceInt,
  htmlUnescape,
  getFinalAnswer,
  getError,
  getUtteranceType,
  getGeneratedSql,
  getReasoningText,
  getFirstExecutionData,
  getConfidenceScore,
  getPhaseDurations,
  getTotalLlmTokens,
  getLlmCallCount,
  getWaiiRequestTraceId,
  getChatLuid,
  CabuHttpError,
  type SseEvent,
} from "./client.ts";

// ---------------------------------------------------------------------------
// Pure request builders
// ---------------------------------------------------------------------------

describe("cabu client — request builders", () => {
  test("buildLoginXml escapes and nests correctly", () => {
    const xml = buildLoginXml("me&you", "p<w>", "site1");
    expect(xml).toContain('name="me&amp;you"');
    expect(xml).toContain('password="p&lt;w&gt;"');
    expect(xml).toContain('contentUrl="site1"');
    expect(xml).toContain("<tsRequest>");
  });

  test("buildCreateConversationBody includes/omits optional keys", () => {
    const body = buildCreateConversationBody({
      workbookLuid: "wb1",
      dashboardDatasources: [{ datasourceLuid: "ds1" }],
      traceId: "trace",
      wgSessionId: "tok",
      vizqlRoutingKey: "vk",
    });
    expect(body).toEqual({
      dashboardDatasources: [{ datasourceLuid: "ds1" }],
      sessionId: "",
      traceId: "trace",
      workbookLuid: "wb1",
      wgSessionId: "tok",
      vizqlRoutingKey: "vk",
    });
  });

  test("buildCreateConversationBody omits workbookLuid when null", () => {
    const body = buildCreateConversationBody({
      workbookLuid: null,
      dashboardDatasources: [{ datasourceLuid: "ds1" }],
      traceId: "t",
    });
    expect("workbookLuid" in body).toBe(false);
  });

  test("buildCreateConversationBody rejects empty workbookLuid and empty datasources", () => {
    expect(() =>
      buildCreateConversationBody({
        workbookLuid: "",
        dashboardDatasources: [{ x: 1 }],
        traceId: "t",
      }),
    ).toThrow(/cannot be empty string/);
    expect(() =>
      buildCreateConversationBody({
        workbookLuid: "wb",
        dashboardDatasources: [],
        traceId: "t",
      }),
    ).toThrow(/dashboard_datasources cannot be empty/);
  });

  test("buildPostUtteranceBody maps sdmNames to datasources", () => {
    const body = buildPostUtteranceBody({
      utterance: "hello",
      scope: "sc",
      sdmNames: ["a", "b"],
      parentLuid: "",
      traceId: "t",
    });
    expect(body.datasources).toEqual([
      { sdmName: "a", datasourceLuid: "a" },
      { sdmName: "b", datasourceLuid: "b" },
    ]);
    expect(body.utterance).toEqual({ content: "hello", source: "user" });
    expect(body.localization).toEqual({ locale: "en_US", language: "en" });
  });

  test("buildPostUtteranceBody rejects empty utterance", () => {
    expect(() =>
      buildPostUtteranceBody({ utterance: "", scope: "s", sdmNames: [], parentLuid: "", traceId: "t" }),
    ).toThrow(/utterance cannot be empty/);
  });
});

// ---------------------------------------------------------------------------
// Pure response parsers
// ---------------------------------------------------------------------------

describe("cabu client — response parsers", () => {
  test("parseLoginXml extracts token/site/user (namespace-tolerant)", () => {
    const xml = `<tsResponse xmlns="http://tableau.com/api">
      <credentials token="TOK123">
        <site id="SITE1" contentUrl="s"/>
        <user id="USER1"/>
      </credentials></tsResponse>`;
    expect(parseLoginXml(xml)).toEqual({ token: "TOK123", siteId: "SITE1", userId: "USER1" });
  });

  test("parseLoginXml round-trips buildLoginXml plus a server-added token", () => {
    // buildLoginXml has no token/site id/user id (request side), so use a response.
    const resp = `<tsResponse><credentials token="T"><site id="S"/><user id="U"/></credentials></tsResponse>`;
    expect(parseLoginXml(resp).token).toBe("T");
  });

  test("parseLoginXml throws when token is missing", () => {
    const xml = `<tsResponse><credentials><site id="S"/><user id="U"/></credentials></tsResponse>`;
    expect(() => parseLoginXml(xml)).toThrow(/Token not found/);
  });

  test("parseCreateConversationResponse handles the old sdmNames format", () => {
    expect(
      parseCreateConversationResponse({
        conversationId: "conv1",
        scope: "sc",
        sdmNames: ["n1", "n2"],
      }),
    ).toEqual({ conversationId: "conv1", scope: "sc", sdmNames: ["n1", "n2"] });
  });

  test("parseCreateConversationResponse handles the new datasources format", () => {
    expect(
      parseCreateConversationResponse({
        conversationId: "conv1",
        scope: "sc",
        datasources: [{ sdmName: "n1", datasourceLuid: "l1" }, { datasourceLuid: "l2" }],
      }),
    ).toEqual({ conversationId: "conv1", scope: "sc", sdmNames: ["n1"] });
  });

  test("parseCreateConversationResponse throws on missing fields", () => {
    expect(() => parseCreateConversationResponse({ scope: "s", sdmNames: ["n"] })).toThrow(
      /No conversationId/,
    );
    expect(() =>
      parseCreateConversationResponse({ conversationId: "c", sdmNames: ["n"] }),
    ).toThrow(/No scope/);
    expect(() =>
      parseCreateConversationResponse({ conversationId: "c", scope: "s" }),
    ).toThrow(/No sdmNames/);
  });

  test("parsePostUtteranceResponse drops non-string b3TraceId", () => {
    expect(parsePostUtteranceResponse({ utteranceId: "u1", b3TraceId: "b3" })).toEqual({
      utteranceId: "u1",
      b3TraceId: "b3",
    });
    expect(parsePostUtteranceResponse({ utteranceId: "u1", b3TraceId: 123 })).toEqual({
      utteranceId: "u1",
      b3TraceId: null,
    });
    expect(() => parsePostUtteranceResponse({})).toThrow(/No utteranceId/);
  });
});

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

describe("cabu client — SSE parsing", () => {
  test("parses framed events and stops at complete", () => {
    const body = [
      "event: classification_complete",
      'data: {"utteranceType": "DATA_QUESTION"}',
      "",
      "event: response_complete",
      'data: {"response": "The answer"}',
      "",
      "event: complete",
      "data: {}",
      "",
      "event: after_complete",
      'data: {"response": "ignored"}',
      "",
    ].join("\n");
    const events = parseSseStream(body);
    expect(events.map((e) => e[0])).toEqual([
      "classification_complete",
      "response_complete",
      "complete",
    ]);
  });

  test("multi-line data lines are joined", () => {
    const body = ['event: x', 'data: {"a":', 'data: 1}', ""].join("\n");
    const events = parseSseStream(body);
    expect(events).toEqual([["x", { a: 1 }]]);
  });

  test("flushes a trailing frame with no blank terminator", () => {
    const body = ['event: response_complete', 'data: {"response":"trail"}'].join("\n");
    const events = parseSseStream(body);
    expect(events).toEqual([["response_complete", { response: "trail" }]]);
  });
});

// ---------------------------------------------------------------------------
// Extraction helpers + small utils
// ---------------------------------------------------------------------------

describe("cabu client — utils", () => {
  test("coerceInt", () => {
    expect(coerceInt(5)).toBe(5);
    expect(coerceInt("42")).toBe(42);
    expect(coerceInt(true)).toBeNull();
    expect(coerceInt("x")).toBeNull();
    expect(coerceInt(1.5)).toBeNull();
  });

  test("htmlUnescape decodes numeric + named entities", () => {
    expect(htmlUnescape("&#36;5 &amp; &lt;x&gt;")).toBe("$5 & <x>");
  });
});

const RICH_EVENTS: SseEvent[] = [
  ["classification_complete", { utteranceType: "DATA_QUESTION" }],
  ["reasoning_complete", { title: "Plan", reasoning: "Look at sales" }],
  ["reasoning_complete", { reasoning: "Then aggregate" }],
  [
    "response_complete",
    {
      response: "Total sales are &#36;100",
      chatLuid: "chat1",
      dataDetails: "one row",
      datatables: [{ data: [{ Sales: 100 }] }],
      debug_context: {
        classification: {
          duration_ms: 12,
          call_a: { llm_response: { generation_details: { parameters: { usage: { total_tokens: 30 } } } } },
        },
        action: { duration_ms: 88 },
        response: {
          task_history: [
            {
              request: { trace_id: "waii-trace" },
              response: {
                response_data: {
                  query: {
                    iter_0_query: {
                      query: "SELECT SUM(sales)",
                      confidenceScore: { confidenceValue: 0.75 },
                      llmResponseWithReasoning: {
                        llmResponse: { llmUsageStats: { tokenTotal: "20" } },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  ],
  ["complete", {}],
];

describe("cabu client — extraction helpers", () => {
  test("getFinalAnswer html-unescapes", () => {
    expect(getFinalAnswer(RICH_EVENTS)).toBe("Total sales are $100");
  });
  test("getUtteranceType", () => {
    expect(getUtteranceType(RICH_EVENTS)).toBe("DATA_QUESTION");
  });
  test("getGeneratedSql from iter_0_query", () => {
    expect(getGeneratedSql(RICH_EVENTS)).toBe("SELECT SUM(sales)");
  });
  test("getReasoningText concatenates titles/text", () => {
    expect(getReasoningText(RICH_EVENTS)).toBe("[Plan] Look at sales\nThen aggregate");
  });
  test("getChatLuid", () => {
    expect(getChatLuid(RICH_EVENTS)).toBe("chat1");
  });
  test("getFirstExecutionData from datatables", () => {
    expect(getFirstExecutionData(RICH_EVENTS)).toEqual([{ Sales: 100 }]);
  });
  test("getConfidenceScore", () => {
    expect(getConfidenceScore(RICH_EVENTS)).toBe(0.75);
  });
  test("getPhaseDurations", () => {
    expect(getPhaseDurations(RICH_EVENTS)).toEqual({
      classification_duration_ms: 12,
      action_duration_ms: 88,
    });
  });
  test("getTotalLlmTokens sums source A + source B", () => {
    expect(getTotalLlmTokens(RICH_EVENTS)).toBe(50);
  });
  test("getLlmCallCount counts call entries", () => {
    expect(getLlmCallCount(RICH_EVENTS)).toBe(1);
  });
  test("getWaiiRequestTraceId", () => {
    expect(getWaiiRequestTraceId(RICH_EVENTS)).toBe("waii-trace");
  });
  test("getError picks event:error and error-carrying response_complete", () => {
    expect(getError([["error", { message: "boom" }]])).toEqual({ message: "boom" });
    expect(getError([["response_complete", { error_code: "E1" }]])).toEqual({ error_code: "E1" });
    expect(getError(RICH_EVENTS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The client driving the three-phase flow with an injected fetch
// ---------------------------------------------------------------------------

function sseBody(): string {
  return [
    "event: classification_complete",
    'data: {"utteranceType":"DATA_QUESTION"}',
    "",
    "event: response_complete",
    'data: {"response":"Hi &amp; welcome","chatLuid":"chat9"}',
    "",
    "event: complete",
    "data: {}",
    "",
  ].join("\n");
}

/** A fake fetch that routes by URL path + method and records requests. */
function makeFakeFetch(recorder: { url: string; init?: RequestInit }[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    recorder.push({ url, init });
    if (url.endsWith("/auth/signin")) {
      return new Response(
        `<tsResponse><credentials token="TOK"><site id="SITE"/><user id="USER"/></credentials></tsResponse>`,
        { status: 200 },
      );
    }
    if (url.endsWith("/conversations")) {
      return new Response(
        JSON.stringify({ conversationId: "conv1", scope: "sc", sdmNames: ["sdm1"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/utterances")) {
      return new Response(JSON.stringify({ utteranceId: "utt1", b3TraceId: "b3x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/stream")) {
      return new Response(sseBody(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("cabu client — three-phase flow (injected fetch)", () => {
  test("login → create → post → stream, with cookies + headers", async () => {
    const recorder: { url: string; init?: RequestInit }[] = [];
    const client = new TabCabuServiceClient({
      baseUrl: "https://host/content-exploration",
      username: "u",
      password: "p",
      sitename: "site",
      fetchImpl: makeFakeFetch(recorder),
      uuidHex: () => "fixedtrace",
    });

    await client.login();
    expect(client.authToken).toBe("TOK");
    expect(client.siteLuid).toBe("SITE");

    const convId = await client.createConversation({
      workbookLuid: "wb1",
      dashboardDatasources: [{ datasourceLuid: "ds1" }],
      wgSessionId: client.authToken,
    });
    expect(convId).toBe("conv1");
    expect(client.scope).toBe("sc");
    expect(client.sdmNames).toEqual(["sdm1"]);
    expect(client.conversationTraceId).toBe("fixedtrace");

    const uttId = await client.postUtterance({ utterance: "hi", wgSessionId: client.authToken });
    expect(uttId).toBe("utt1");
    expect(client.utteranceB3TraceId).toBe("b3x");

    const events = await client.streamConversation();
    expect(client.getFinalAnswer(events)).toBe("Hi & welcome");
    expect(client.getChatLuid(events)).toBe("chat9");

    // Auth header + cookie present on the conversation request.
    const convReq = recorder.find((r) => r.url.endsWith("/conversations"))!;
    const headers = convReq.init!.headers as Record<string, string>;
    expect(headers["X-Tableau-Auth"]).toBe("TOK");
    expect(headers.Cookie).toContain("workgroup_session_id=TOK");
    expect(headers.Cookie).toContain("XSRF-TOKEN=tableau-ai-eval");

    // Stream request forwards the b3 trace id and XSRF header.
    const streamReq = recorder.find((r) => r.url.endsWith("/stream"))!;
    const sHeaders = streamReq.init!.headers as Record<string, string>;
    expect(sHeaders["x-b3-traceid"]).toBe("b3x");
    expect(sHeaders["X-XSRF-TOKEN"]).toBe("tableau-ai-eval");
  });

  test("childClient inherits auth but isolates conversation state", async () => {
    const client = new TabCabuServiceClient({
      baseUrl: "https://host/ce",
      fetchImpl: makeFakeFetch([]),
    });
    client.authToken = "TOK";
    client.siteLuid = "SITE";
    const child = client.childClient();
    expect(child.authToken).toBe("TOK");
    expect(child.siteLuid).toBe("SITE");
    expect(child.conversationId).toBeNull();
    expect(child).not.toBe(client);
  });

  test("retains and updates server context cookies across phases without leaking to siblings", async () => {
    const recorder: { url: string; init?: RequestInit }[] = [];
    const fake = makeFakeFetch(recorder);
    const parent = new TabCabuServiceClient({
      baseUrl: "https://host/content-exploration",
      fetchImpl: async (input, init) => {
        const response = await fake(input, init);
        const url = String(input);
        if (url.endsWith("/conversations")) {
          response.headers.append("Set-Cookie", "cabuCtx=conversation==; Path=/; HttpOnly; Secure");
          response.headers.append("Set-Cookie", "route=node1; Path=/; Secure");
          response.headers.append("Set-Cookie", "XSRF-TOKEN=unpaired; Path=/");
        } else if (url.endsWith("/utterances")) {
          response.headers.append("Set-Cookie", "cabuCtx=utterance==; Path=/; HttpOnly; Secure");
          response.headers.append("Set-Cookie", "route=; Max-Age=0; Path=/");
        }
        return response;
      },
    });
    parent.authToken = "TOK";
    const child = parent.childClient();
    await child.createConversation({ workbookLuid: "wb1", dashboardDatasources: [{ datasourceLuid: "ds1" }] });
    await child.postUtterance({ utterance: "hi" });
    await child.streamConversation();
    const postHeaders = recorder[1].init!.headers as Record<string, string>;
    expect(postHeaders.Cookie).toContain("cabuCtx=conversation==");
    expect(postHeaders.Cookie).toContain("route=node1");
    const streamHeaders = recorder[2].init!.headers as Record<string, string>;
    expect(streamHeaders.Cookie).toContain("cabuCtx=utterance==");
    expect(streamHeaders.Cookie).not.toContain("route=");
    expect(streamHeaders.Cookie).toContain("workgroup_session_id=TOK");
    expect(streamHeaders.Cookie).toContain("XSRF-TOKEN=tableau-ai-eval");
    expect(streamHeaders["X-XSRF-TOKEN"]).toBe("tableau-ai-eval");
    for (const isolated of [parent.childClient(), child.childClient()]) {
      await isolated.createConversation({ workbookLuid: "wb2", dashboardDatasources: [{ datasourceLuid: "ds2" }] });
      const headers = recorder.at(-1)!.init!.headers as Record<string, string>;
      expect(headers.Cookie).not.toContain("cabuCtx=");
    }
  });

  test("HTTP error surfaces as CabuHttpError carrying the status", async () => {
    const fetchImpl = async () => new Response("nope", { status: 401 });
    const client = new TabCabuServiceClient({
      baseUrl: "https://host/ce",
      username: "u",
      password: "p",
      sitename: "s",
      fetchImpl,
    });
    let err: unknown;
    try {
      await client.login();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CabuHttpError);
    expect((err as CabuHttpError).status).toBe(401);
    expect((err as CabuHttpError).phase).toBe("login");
  });
});

describe("cabu client — TLS ergonomics (verify / private-CA)", () => {
  test("child clients preserve the private CA for every question phase", async () => {
    const recorder: { url: string; init?: RequestInit }[] = [];
    const parent = new TabCabuServiceClient({
      baseUrl: "https://host/ce",
      sslVerify: true,
      caBundlePath: "/tmp/tableau-ai-eval-ca.pem",
      fetchImpl: makeFakeFetch(recorder),
    });
    parent.authToken = "TOK";
    const child = parent.childClient().childClient();
    await child.createConversation({ workbookLuid: "wb1", dashboardDatasources: [{ datasourceLuid: "ds1" }] });
    await child.postUtterance({ utterance: "hi" });
    await child.streamConversation();
    expect(recorder).toHaveLength(3);
    for (const request of recorder) {
      const tls = (request.init as { tls?: { ca?: Bun.BunFile; rejectUnauthorized?: boolean } }).tls;
      expect(tls?.ca?.name).toBe("/tmp/tableau-ai-eval-ca.pem");
      expect(tls?.rejectUnauthorized).toBeUndefined();
    }
  });

  test("trusts a private CA when sslVerify=true + caBundlePath", async () => {
    const recorder: { url: string; init?: RequestInit }[] = [];
    const client = new TabCabuServiceClient({
      baseUrl: "https://host/ce",
      username: "u",
      password: "p",
      sitename: "s",
      sslVerify: true,
      caBundlePath: "/tmp/tableau-ai-eval-ca.pem",
      fetchImpl: makeFakeFetch(recorder),
    });
    await client.login();
    const signin = recorder.find((r) => r.url.endsWith("/auth/signin"))!;
    const tls = (signin.init as { tls?: { ca?: unknown; rejectUnauthorized?: boolean } }).tls;
    expect(tls).toBeTruthy();
    expect(tls!.ca).toBeTruthy();
    expect(tls!.rejectUnauthorized).toBeUndefined();
  });

  test("disables verification when sslVerify=false (default)", async () => {
    const recorder: { url: string; init?: RequestInit }[] = [];
    const client = new TabCabuServiceClient({
      baseUrl: "https://host/ce",
      username: "u",
      password: "p",
      sitename: "s",
      sslVerify: false,
      fetchImpl: makeFakeFetch(recorder),
    });
    await client.login();
    const signin = recorder.find((r) => r.url.endsWith("/auth/signin"))!;
    const tls = (signin.init as { tls?: { rejectUnauthorized?: boolean } }).tls;
    expect(tls!.rejectUnauthorized).toBe(false);
  });

  test("uses system trust (no tls) when sslVerify=true + no caBundlePath", async () => {
    const recorder: { url: string; init?: RequestInit }[] = [];
    const client = new TabCabuServiceClient({
      baseUrl: "https://host/ce",
      username: "u",
      password: "p",
      sitename: "s",
      sslVerify: true,
      fetchImpl: makeFakeFetch(recorder),
    });
    await client.login();
    const signin = recorder.find((r) => r.url.endsWith("/auth/signin"))!;
    expect((signin.init as { tls?: unknown }).tls).toBeUndefined();
  });
});
