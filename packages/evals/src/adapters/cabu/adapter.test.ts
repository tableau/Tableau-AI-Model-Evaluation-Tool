import { describe, expect, test } from "bun:test";
import {
  createCabuAdapter,
  describeCabuError,
  explainFailure,
  resolveLuids,
  resolveTargets,
  serializeCase,
  RUNNER_NAME,
  type CabuCase,
} from "./adapter.ts";
import { CabuHttpError, TabCabuServiceClient } from "./client.ts";
import type { JudgeCaller } from "./judge.ts";
import type { RowPayload, RunConfig } from "@tableau-ai-eval/core";
import { TableauSession, shareSession, unshareSession } from "@tableau-ai-eval/core";

// ---------------------------------------------------------------------------
// A fake fetch for the shared client that responds to the three phases.
// ---------------------------------------------------------------------------

function makeFakeFetch(sseByUtterance: (u: string) => string) {
  let lastUtterance = "";
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/conversations")) {
      return new Response(
        JSON.stringify({ conversationId: "conv1", scope: "sc", sdmNames: ["sdm1"] }),
        { status: 200 },
      );
    }
    if (url.endsWith("/utterances")) {
      const body = JSON.parse(String(init!.body));
      lastUtterance = body.utterance.content;
      return new Response(JSON.stringify({ utteranceId: "utt1", b3TraceId: "b3" }), {
        status: 200,
      });
    }
    if (url.endsWith("/stream")) {
      return new Response(sseByUtterance(lastUtterance), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("nf", { status: 404 });
  };
}

function sseFor(utterance: string): string {
  return [
    "event: classification_complete",
    'data: {"utteranceType":"DATA_QUESTION"}',
    "",
    "event: response_complete",
    `data: {"response":"reply to ${utterance}","chatLuid":"chat1","datatables":[{"data":[{"v":1}]}]}`,
    "",
    "event: complete",
    "data: {}",
    "",
  ].join("\n");
}

const CASES: CabuCase[] = [
  {
    caseId: "case.1",
    input: {
      utterance: "what are sales?",
      utteranceId: "case.1",
      ground_truth_answer: "Sales are 100",
      expected_output_types: ["DATA_QUESTION"],
    },
    tags: ["smoke"],
  },
  {
    caseId: "case.2",
    input: { utterance: "and profit?", ground_truth_answer: "Profit is 20" },
    tags: [],
  },
];

const CONFIG: RunConfig = {
  max_concurrency: 1,
  workbook_luid: "wb1",
  datasource_luid: "ds1",
  datasource_name: "Superstore",
  cabu_base_url: "https://host/content-exploration",
};

function buildAdapter(opts?: {
  cases?: CabuCase[];
  judgeCaller?: JudgeCaller;
  resolveJudgeConfig?: (c: RunConfig) => { provider?: string; model?: string; api_key?: string } | null;
  clientFactory?: () => TabCabuServiceClient;
}) {
  return createCabuAdapter({
    loadSuite: () => opts?.cases ?? CASES,
    clientFactory:
      opts?.clientFactory ??
      (() =>
        new TabCabuServiceClient({
          baseUrl: "https://host/content-exploration",
          fetchImpl: makeFakeFetch(sseFor),
          uuidHex: () => "t",
        })),
    judgeCaller: opts?.judgeCaller,
    resolveJudgeConfig: opts?.resolveJudgeConfig,
    clock: (() => {
      let t = 0;
      return () => {
        t += 1000;
        return t;
      };
    })(),
  });
}

describe("cabu adapter — LUID resolution", () => {
  test("config overrides win over placeholder YAML", () => {
    expect(
      resolveLuids(
        { workbook_luid: "cfgwb", datasource_luid: "cfgds" },
        { workbook_luid: "PLACEHOLDER", datasource_luid: "PLACEHOLDER" },
      ),
    ).toEqual({ workbookLuid: "cfgwb", datasourceLuid: "cfgds", datasourceName: null });
  });
  test("falls back to non-placeholder YAML values", () => {
    expect(
      resolveLuids({}, { workbook_luid: "ywb", datasource_luid: "yds", datasource_name: "N" }),
    ).toEqual({ workbookLuid: "ywb", datasourceLuid: "yds", datasourceName: "N" });
  });
  test("throws when neither resolves", () => {
    expect(() => resolveLuids({}, { workbook_luid: "PLACEHOLDER" })).toThrow(
      /need the published workbook\/datasource LUIDs/,
    );
  });
});

describe("cabu adapter — several data sources", () => {
  test("resolveTargets handles one or several sources", () => {
    const one = { workbook_luid: "PLACEHOLDER", datasource_luid: "PLACEHOLDER" };
    expect(
      resolveTargets({ workbook_luid: "wb", datasource_luid: "d1", datasource_name: "Claims" }, one),
    ).toEqual({ workbookLuid: "wb", datasources: [{ datasourceLuid: "d1", name: "Claims" }] });

    // A two-source suite lists its sources; the run config fills them in order.
    const two = {
      workbook_luid: "PLACEHOLDER",
      datasource_luids: ["PLACEHOLDER", "PLACEHOLDER"],
      datasource_names: ["Insurance Claims", "Customer Lifetime Value"],
    };
    expect(
      resolveTargets(
        {
          workbook_luid: "wb",
          datasource_luids: ["d1", "d2"],
          datasource_names: ["Insurance Claims", "Customer Lifetime Value"],
        },
        two,
      ).datasources,
    ).toEqual([
      { datasourceLuid: "d1", name: "Insurance Claims" },
      { datasourceLuid: "d2", name: "Customer Lifetime Value" },
    ]);
    // Real ids in the YAML are honoured when the config gives none.
    expect(
      resolveTargets({ workbook_luid: "wb" }, { ...two, datasource_luids: ["y1", "y2"] }).datasources.map(
        (d) => d.datasourceLuid,
      ),
    ).toEqual(["y1", "y2"]);
    // A partly filled list does not stand in for a two-source suite.
    expect(() =>
      resolveTargets({ workbook_luid: "wb", datasource_luids: ["d1", "PLACEHOLDER"] }, two),
    ).toThrow(/datasource_luids/);
  });

  test("execute registers every source of a two-source suite", async () => {
    const bodies: Record<string, unknown>[] = [];
    const base = makeFakeFetch(sseFor);
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/conversations")) bodies.push(JSON.parse(String(init!.body)));
      return base(input, init);
    };
    const cases: CabuCase[] = [
      {
        caseId: "insurance.a.1",
        input: {
          utterance: "Total claims?",
          ground_truth_answer: "1",
          expected_output_types: ["Metrics"],
          workbook_luid: "PLACEHOLDER",
          datasource_luids: ["PLACEHOLDER", "PLACEHOLDER"],
          datasource_names: ["Insurance Claims", "Customer Lifetime Value"],
        },
        tags: ["Aggregation"],
      },
    ];
    const adapter = buildAdapter({
      cases,
      clientFactory: () =>
        new TabCabuServiceClient({
          baseUrl: "https://host/content-exploration",
          fetchImpl,
          uuidHex: () => "t",
        }),
    });
    const config: RunConfig = {
      workbook_luid: "wb1",
      datasource_luids: ["d1", "d2"],
      datasource_names: ["Insurance Claims", "Customer Lifetime Value"],
      cabu_base_url: "https://host/content-exploration",
    };
    const plan = await adapter.load(config);
    const rows: RowPayload[] = [];
    await adapter.execute(plan, config, async (r) => void rows.push(r), () => null, new Set());
    expect(bodies.length).toBe(1);
    expect(bodies[0]!.workbookLuid).toBe("wb1");
    expect(bodies[0]!.dashboardDatasources).toEqual([
      { datasourceLuid: "d1", name: "Insurance Claims" },
      { datasourceLuid: "d2", name: "Customer Lifetime Value" },
    ]);
    expect(rows[0]!.metrics.dashboardQA).toBeUndefined();
  });
});

describe("cabu adapter — suite plan", () => {
  test("totals, skeletons, conversation_ids (single-case conversations)", async () => {
    const adapter = buildAdapter();
    const plan = await adapter.load(CONFIG);
    expect(plan.total).toBe(2);
    expect(plan.conversation_ids).toEqual([["case.1"], ["case.2"]]);
    expect(plan.skeletons[0]).toEqual({
      test_case_id: "case.1",
      runner: RUNNER_NAME,
      datasource: "Superstore",
      utterance: "what are sales?",
      expected: { user_friendly_reply: "Sales are 100", output_type: "SQ" },
    });
  });

  test("load throws when the first case has no LUIDs", async () => {
    const adapter = buildAdapter({
      cases: [{ caseId: "x", input: { utterance: "u" }, tags: [] }],
    });
    await expect(adapter.load({ cabu_base_url: "https://h/ce" })).rejects.toThrow(
      /workbook\/datasource LUIDs/,
    );
  });

  test("load throws when empty", async () => {
    const adapter = buildAdapter({ cases: [] });
    await expect(adapter.load(CONFIG)).rejects.toThrow(/No runnable CABU cases/);
  });
});

describe("cabu adapter — execute + serialize", () => {
  test("a structured SSE error with no answer is a failed question: retried, worded, actual empty", async () => {
    // Was: the raw code and details on an "answered" row. The agent reported
    // an error instead of an answer, so the question is asked again and then
    // recorded as failed (Resume re-asks it); the wording keeps the code and
    // details and the debug info keeps the payload. (2026-10-21)
    const error = {
      node: "response",
      error_code: "REACT_UTTERANCE_CLASSIFICATION_ERROR",
      error_details: 'I/O error on POST request for "http://proxy:8080/OpenAIConnectorProxy/chat/completions": proxy',
    };
    const slept: number[] = [];
    const adapter = createCabuAdapter({
      loadSuite: () => [CASES[0]!],
      clientFactory: () => new TabCabuServiceClient({
        baseUrl: "https://host/content-exploration",
        fetchImpl: makeFakeFetch(() => `event: response_complete\ndata: ${JSON.stringify(error)}\n\nevent: complete\ndata: {}\n\n`),
      }),
      sleep: async (ms) => void slept.push(ms),
      clock: () => 0,
    });
    const plan = await adapter.load(CONFIG);
    const rows: RowPayload[] = [];
    await adapter.execute(plan, CONFIG, async (r) => void rows.push(r), () => null, new Set());
    expect(slept.reduce((a, b) => a + b, 0)).toBe(10_000 + 30_000 + 60_000);
    const description = String((rows[0]!.errors as { description: string }[])[0]!.description);
    expect(description).toStartWith("Tableau Server's Dashboard Q&A agent answered with an error instead of an answer");
    expect(description).toContain(`${error.error_code}): ${error.error_details}`);
    expect(rows[0]!.actual).toEqual({});
  });

  for (const eventName of ["error", "response_complete"]) {
    test(`saves ${eventName} errors alongside an answer and its scores`, async () => {
      const answer = "I ran into a technical error while generating the query.";
      const error = {
        error_code: "QUERY_TRANSLATION_ERROR",
        error_details: "Query translation failed",
        api_key: "private-value",
      };
      const adapter = buildAdapter({
        cases: [CASES[0]],
        judgeCaller: async () => '{"score":0,"explanation":"No data retrieved"}',
        resolveJudgeConfig: () => ({ provider: "openai", model: "test", api_key: "key" }),
        clientFactory: () => new TabCabuServiceClient({
          baseUrl: "https://host/content-exploration",
          fetchImpl: makeFakeFetch(() => [
            ...(eventName === "error" ? [
              "event: error", `data: ${JSON.stringify(error)}`, "",
            ] : []),
            "event: response_complete",
            `data: ${JSON.stringify({ response: answer, ...(eventName === "response_complete" ? error : {}) })}`,
            "", "event: complete", "data: {}", "",
          ].join("\n")),
        }),
      });
      const config = { ...CONFIG, compute_nl_judge: true };
      const plan = await adapter.load(config);
      const rows: RowPayload[] = [];
      await adapter.execute(plan, config, async (r) => void rows.push(r), () => null, new Set());
      expect(rows).toHaveLength(1);
      expect(rows[0].actual.user_friendly_reply).toBe(answer);
      expect(rows[0].errors).toEqual([{
        phase: "cabu",
        description: "QUERY_TRANSLATION_ERROR: Query translation failed",
        warning: false,
      }]);
      expect(rows[0].debug_info.server_error).toMatchObject({
        error_code: error.error_code,
        error_details: error.error_details,
      });
      expect(JSON.stringify(rows[0].debug_info)).not.toContain("private-value");
      expect(rows[0].metrics.llmJudge).toHaveLength(4);
    });
  }

  test("error descriptions handle alternative fields and unknown structured payloads", () => {
    expect(describeCabuError({ errorCode: "FAIL", errorMsg: "Server failed" })).toBe("FAIL: Server failed");
    expect(describeCabuError({ error_details: { message: "Nested detail" } })).toBe("Nested detail");
    expect(describeCabuError({ unexpected: true })).toBe('{"unexpected":true}');
    expect(describeCabuError(new Error("Failure"))).toBe("Failure");
    expect(describeCabuError("Already readable")).toBe("Already readable");
    const row = serializeCase(CASES[0], "Claims", { error: { message: "Failure", api_key: "private-value" } });
    expect(JSON.stringify(row.debug_info)).not.toContain("private-value");
  });

  test("drives the client and emits normalized rows", async () => {
    const adapter = buildAdapter();
    const plan = await adapter.load(CONFIG);
    const rows: RowPayload[] = [];
    await adapter.execute(plan, CONFIG, async (r) => void rows.push(r), () => null, new Set());

    expect(rows).toHaveLength(2);
    const r = rows[0]!;
    expect(r.test_case_id).toBe("case.1");
    expect(r.runner).toBe(RUNNER_NAME);
    expect(r.datasource).toBe("Superstore");
    expect(r.actual.user_friendly_reply).toBe("reply to what are sales?");
    expect(r.actual.utterance_type).toBe("DATA_QUESTION");
    // outputType metric: expected DATA_QUESTION == observed DATA_QUESTION → 1.0
    expect(r.metrics.dashboardQA).toBeUndefined();
    expect(r.latency).toBe(1); // (2000-1000)/1000
    expect(r.info).toEqual({ tags: ["smoke"] });
  });

  test("serializeCase surfaces an error outcome", () => {
    const row = serializeCase(CASES[0]!, "Superstore", { error: "TypeError: boom" });
    expect(row.actual).toEqual({});
    expect(row.errors).toEqual([{ phase: "cabu", description: "TypeError: boom", warning: false }]);
  });
});

describe("cabu adapter — resume skip + should_stop", () => {
  test("skips completed case ids", async () => {
    const adapter = buildAdapter();
    const plan = await adapter.load(CONFIG);
    const rows: RowPayload[] = [];
    await adapter.execute(
      plan,
      CONFIG,
      async (r) => void rows.push(r),
      () => null,
      new Set(["case.1"]),
    );
    expect(rows.map((r) => r.test_case_id)).toEqual(["case.2"]);
  });

  test("should_stop halts before running any case", async () => {
    const adapter = buildAdapter();
    const plan = await adapter.load(CONFIG);
    const rows: RowPayload[] = [];
    await adapter.execute(plan, CONFIG, async (r) => void rows.push(r), () => "cancel", new Set());
    expect(rows).toHaveLength(0);
  });
});

describe("cabu adapter — judge wiring", () => {
  test("attaches judge entries when compute_nl_judge + judge config present", async () => {
    const judgeCaller: JudgeCaller = async () => '{"score": 8, "explanation": "ok"}';
    const adapter = buildAdapter({
      judgeCaller,
      resolveJudgeConfig: () => ({ provider: "openai", model: "gpt-4o", api_key: "k" }),
    });
    const plan = await adapter.load(CONFIG);
    const rows: RowPayload[] = [];
    await adapter.execute(
      { ...plan },
      { ...CONFIG, compute_nl_judge: true },
      async (r) => void rows.push(r),
      () => null,
      new Set(),
    );
    const judged = rows[0]!.metrics.llmJudge!;
    expect(new Set(judged.map((e) => e.metric_name))).toEqual(
      new Set([
        "answerCorrectness",
        "factualConsistency",
        "coherence_dashboard_qa",
        "relevance_dashboard_qa",
      ]),
    );
    expect(judged[0]!.metric_id).toBe("CabuJudge");
    expect(judged.every((e) => e.score === 0.8)).toBe(true);
  });

  test("no judge attached when compute_nl_judge is false", async () => {
    const adapter = buildAdapter({
      judgeCaller: async () => '{"score": 8}',
      resolveJudgeConfig: () => ({ provider: "openai", model: "gpt-4o", api_key: "k" }),
    });
    const plan = await adapter.load(CONFIG);
    const rows: RowPayload[] = [];
    await adapter.execute(plan, CONFIG, async (r) => void rows.push(r), () => null, new Set());
    expect(rows[0]!.metrics.llmJudge).toBeUndefined();
  });
});

describe("cabu adapter — auth-failure circuit breaker", () => {
  test("three consecutive 401s abort the run", async () => {
    const cases: CabuCase[] = [1, 2, 3, 4].map((i) => ({
      caseId: `c${i}`,
      input: { utterance: `u${i}`, ground_truth_answer: "g" },
      tags: [],
    }));
    const alwaysUnauthorized = async () => new Response("no", { status: 401 });
    const adapter = createCabuAdapter({
      loadSuite: () => cases,
      clientFactory: () =>
        new TabCabuServiceClient({
          baseUrl: "https://host/ce",
          fetchImpl: alwaysUnauthorized,
        }),
      clock: () => 0,
    });
    const plan = await adapter.load(CONFIG);
    await expect(
      adapter.execute(plan, CONFIG, async () => {}, () => null, new Set()),
    ).rejects.toThrow(/consecutive auth failures/);
  });
});

test("server failures are explained for the admin", () => {
  const httpError = (status: number, body: string) => new CabuHttpError(status, body, "postUtterance");

  const waii = explainFailure(
    httpError(502, '{"errorMsg": "502 WAII AddConnection failed: WAII service not available"}'),
  );
  expect(waii).toContain("Dashboard Q&A service is not available");
  expect(waii).toContain("WAII service not available");
  expect(waii).toContain("Tableau administrator");
  expect(
    explainFailure(
      httpError(403, '{"errorMsg": "403 The Tableau Agent Dashboard site setting is not enabled for this site."}'),
    ),
  ).toContain("site setting");
  expect(explainFailure(httpError(404, "not found"))).toContain("HTTP 404 while submitting the question");
  expect(explainFailure(new CabuHttpError(404, JSON.stringify({ errorMsg: "404 Missing cabuCtx cookie" }), "streamConversation")))
    .toContain("HTTP 404 while streaming the answer. The server said: 404 Missing cabuCtx cookie");
  expect(explainFailure(httpError(500, "boom"))).toContain("HTTP 500");
  const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  expect(explainFailure(refused)).toContain("could not be reached");
  class ValueError extends Error {}
  expect(explainFailure(new ValueError("odd"))).toBe("ValueError: odd");
});

test("execute stops after repeated service failures", async () => {
  // A service that is down answers every question the same way; after a few
  // in a row the run stops with the reason instead of asking the rest.
  const cases: CabuCase[] = [1, 2, 3, 4, 5].map((i) => ({
    caseId: `a.${i}`,
    input: { utterance: `Q${i}`, ground_truth_answer: "x", expected_output_types: ["Metrics"] },
    tags: [],
  }));
  const serviceDown = async () =>
    new Response('{"errorMsg": "502 WAII AddConnection failed: WAII service not available"}', {
      status: 502,
    });
  const adapter = createCabuAdapter({
    loadSuite: () => cases,
    clientFactory: () => new TabCabuServiceClient({ baseUrl: "https://host/ce", fetchImpl: serviceDown }),
    sleep: async () => {},
    clock: () => 0,
  });
  const plan = await adapter.load(CONFIG);
  const emitted: RowPayload[] = [];
  let error: unknown;
  try {
    await adapter.execute(plan, CONFIG, async (row) => void emitted.push(row), () => null, new Set());
  } catch (exc) {
    error = exc;
  }
  expect(String(error)).toContain("3 questions in a row failed the same way");
  expect(String(error)).toContain("Dashboard Q&A service is not available");
  expect(emitted).toHaveLength(3); // the failing cases are recorded, the rest never asked
  for (const row of emitted) {
    expect(String((row.errors as { description: string }[])[0]!.description)).toContain("not available");
  }
});

// ---------------------------------------------------------------------------
// The server's data source indexing limit, and error events in place of answers
// ---------------------------------------------------------------------------

const RATE_LIMIT_BODY =
  '{"errorMsg":"502 All SDM indexing failed: 429 WAII IndexSdm failed for \'Auto Insurance\': ' +
  "[localhost:8184] Waii gRPC indexSdm failed (Status{code=RESOURCE_EXHAUSTED, description=IndexSdm " +
  'rate limit exceeded for this tenant/SDM, cause=null})"}';

test("the indexing limit is waited out without using up the retries", async () => {
  let conversations = 0;
  const base = makeFakeFetch(sseFor);
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/conversations") && ++conversations <= 2) {
      return new Response(RATE_LIMIT_BODY, { status: 502 });
    }
    return base(input, init);
  };
  const slept: number[] = [];
  const adapter = createCabuAdapter({
    loadSuite: () => [CASES[0]!],
    clientFactory: () => new TabCabuServiceClient({ baseUrl: "https://host/ce", fetchImpl }),
    sleep: async (ms) => void slept.push(ms),
    clock: () => 0,
  });
  const plan = await adapter.load(CONFIG);
  const emitted: RowPayload[] = [];
  await adapter.execute(plan, CONFIG, async (row) => void emitted.push(row), () => null, new Set());
  expect(slept.reduce((a, b) => a + b, 0)).toBe(60_000 + 120_000); // the limit's waits, not 10 + 30 s
  expect((emitted[0]!.actual as { user_friendly_reply: string }).user_friendly_reply).toBe("reply to what are sales?");
  const warnings = (emitted[0]!.errors as { description: string; warning: boolean }[]).filter((e) => e.warning);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.description).toContain("Waited 3 minutes");
  expect(warnings[0]!.description).toContain("indexing limit");
});

test("a limit that never clears is recorded after the waits are used up", async () => {
  const fetchImpl = async () => new Response(RATE_LIMIT_BODY, { status: 502 });
  const slept: number[] = [];
  const adapter = createCabuAdapter({
    loadSuite: () => [CASES[0]!],
    clientFactory: () => new TabCabuServiceClient({ baseUrl: "https://host/ce", fetchImpl }),
    sleep: async (ms) => void slept.push(ms),
    clock: () => 0,
  });
  const plan = await adapter.load(CONFIG);
  const emitted: RowPayload[] = [];
  await adapter.execute(plan, CONFIG, async (row) => void emitted.push(row), () => null, new Set());
  const total = slept.reduce((a, b) => a + b, 0);
  expect(total).toBeLessThanOrEqual(3_600_000);
  expect(total).toBeGreaterThanOrEqual(3_600_000 - 900_000);
  const text = (emitted[0]!.errors as { description: string }[])[0]!.description;
  expect(text).toStartWith("The server limits how often a data source can be indexed");
  expect(text).toContain("waited");
  expect(text).toContain("raise the WAII indexing limit");
});

test("an error event in place of an answer is a failed question asked again", async () => {
  const sseError = [
    "event: classification_complete",
    'data: {"utteranceType":"DATA_QUESTION"}',
    "",
    "event: error",
    'data: {"node":"response","error_code":"REACT_UTTERANCE_CLASSIFICATION_ERROR","error_details":"I/O error on POST request for \\"http://gw:8080/OpenAIConnectorProxy/chat/completions\\": gw"}',
    "",
    "event: complete",
    "data: {}",
    "",
  ].join("\n");
  let streams = 0;
  const base = makeFakeFetch(() => {
    streams += 1;
    return sseError;
  });
  const slept: number[] = [];
  const adapter = createCabuAdapter({
    loadSuite: () => [CASES[0]!],
    clientFactory: () => new TabCabuServiceClient({ baseUrl: "https://host/ce", fetchImpl: base }),
    sleep: async (ms) => void slept.push(ms),
    clock: () => 0,
  });
  const plan = await adapter.load(CONFIG);
  const emitted: RowPayload[] = [];
  await adapter.execute(plan, CONFIG, async (row) => void emitted.push(row), () => null, new Set());
  expect(streams).toBe(4);
  expect(slept.reduce((a, b) => a + b, 0)).toBe(10_000 + 30_000 + 60_000);
  const text = (emitted[0]!.errors as { description: string }[])[0]!.description;
  expect(text).toStartWith("Tableau Server's Dashboard Q&A agent answered with an error instead of an answer");
  expect(text).toContain("REACT_UTTERANCE_CLASSIFICATION_ERROR");
  expect(text).toContain("OpenAIConnectorProxy");
  expect(emitted[0]!.actual).toEqual({});
});

describe("concurrent CABU authentication and isolation", () => {
  async function exercise(mode: "401" | "403" | "flaky" | "persistent" | "pause" | "churn" | "revoked") {
    const jobId = `cabu-concurrency-${mode}`;
    let signins = 0;
    let oldRequests = 0;
    let creates = 0;
    let stop = false;
    let authFailures = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const utterances = new Map<string, string>();
    const cookies = new Map<string, string>();
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/signin")) {
        signins++;
        if (mode === "revoked" && signins > 1) return new Response("revoked", { status: 401 });
        return Response.json({ credentials: { token: `t${signins}`, site: { id: "site" } } });
      }
      if (url.endsWith("/conversations")) {
        const id = `conv${++creates}`;
        const token = new Headers(init?.headers).get("X-Tableau-Auth");
        if (mode === "403") return new Response("disabled", { status: 403 });
        if (mode === "persistent") return new Response("rate limit", { status: 502 });
        if (["401", "pause", "churn", "revoked"].includes(mode) && token === "t1") {
          if (++oldRequests === 3) { if (mode === "pause") stop = true; release(); }
          await barrier;
          return new Response("session ended", { status: 401 });
        }
        if (mode === "churn") return new Response("session ended again", { status: 401 });
        if (mode === "flaky" && creates <= 3) return new Response("rate limit", { status: 429 });
        cookies.set(id, `ctx=${id}`);
        return Response.json({ conversationId: id, scope: id, sdmNames: [id] }, {
          headers: { "Set-Cookie": `ctx=${id}; Path=/` },
        });
      }
      const id = url.match(/conversations\/(conv\d+)/)?.[1]!;
      expect(new Headers(init?.headers).get("Cookie")).toContain(cookies.get(id)!);
      if (url.endsWith("/utterances")) {
        utterances.set(id, JSON.parse(String(init?.body)).utterance.content);
        return Response.json({ utteranceId: `utt-${id}`, b3TraceId: id });
      }
      if (url.endsWith("/stream")) return new Response(sseFor(utterances.get(id)!));
      return new Response("missing", { status: 404 });
    };
    const session = new TableauSession({ serverUrl: "https://host", patName: "p", patSecret: "s",
      onAuthFailure: () => { authFailures++; stop = true; },
      fetchImpl: fetchImpl as typeof fetch });
    shareSession(jobId, session);
    const parent = new TabCabuServiceClient({ baseUrl: "https://host/ce", fetchImpl });
    parent.authToken = await session.getToken();
    const cases = [1, 2, 3, 4, 5].map(i => ({ caseId: `c${i}`, input: { utterance: `Q${i}` }, tags: [] }));
    const adapter = createCabuAdapter({ loadSuite: () => cases, clientFactory: () => parent,
      sleep: async () => {}, clock: () => 0 });
    const config = { ...CONFIG, job_id: jobId, max_concurrency: 3 };
    const rows: RowPayload[] = [];
    let error: unknown;
    try {
      await adapter.execute(await adapter.load(config), config, async row => { rows.push(row); },
        () => stop ? "pause" : null, new Set());
    } catch (exc) { error = exc; }
    finally { unshareSession(jobId); }
    return { rows, signins, creates, oldRequests, authFailures, error };
  }

  test("three overlapping lost-token requests share one replacement signin and isolated conversations", async () => {
    const result = await exercise("401");
    expect(result.error).toBeUndefined();
    expect(result.oldRequests).toBe(3);
    expect(result.signins).toBe(2);
    expect(result.rows).toHaveLength(5);
    for (const row of result.rows) expect(row.actual.user_friendly_reply).toBe(`reply to Q${row.test_case_id.slice(1)}`);
  });

  test("403 never reauthenticates and drains all started failures", async () => {
    const result = await exercise("403");
    expect(String(result.error)).toContain("consecutive auth failures");
    expect(result.signins).toBe(1);
    expect(result.rows).toHaveLength(3);
    expect(result.creates).toBe(3);
  });

  test("transient rate limits recover with backoff and a fresh child client", async () => {
    const result = await exercise("flaky");
    expect(result.error).toBeUndefined();
    expect(result.signins).toBe(1);
    expect(result.rows).toHaveLength(5);
    expect(result.creates).toBe(8);
  });

  test("persistent failures exhaust retries, persist in-flight rows, and stop dispatch", async () => {
    const result = await exercise("persistent");
    expect(String(result.error)).toContain("3 questions in a row");
    expect(result.rows).toHaveLength(3);
    expect(result.creates).toBe(12);
    expect(result.rows.every(row => row.errors.length > 0)).toBe(true);
  });

  test("pause prevents recovery signin and dispatch of queued cases", async () => {
    const result = await exercise("pause");
    expect(result.signins).toBe(1);
    expect(result.creates).toBe(3);
    expect(result.rows).toHaveLength(3);
  });

  test("repeated external invalidation is bounded instead of causing signin churn", async () => {
    const result = await exercise("churn");
    expect(result.signins).toBe(2);
    expect(result.creates).toBe(6);
    expect(result.rows).toHaveLength(3);
    expect(String(result.error)).toContain("consecutive auth failures");
  });

  test("a revoked PAT notifies the run to pause and drains affected cases", async () => {
    const result = await exercise("revoked");
    expect(result.signins).toBe(2);
    expect(result.authFailures).toBe(1);
    expect(result.creates).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every(row => row.errors.length > 0)).toBe(true);
  });
});
