import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NlqHarnessRunner,
  RateLimiter,
  parseCalcsFormula,
  findSubEntry,
  conversationFromFile,
  resolveFixturesDir,
  requestTimeoutS,
  DEFAULT_REQUEST_TIMEOUT_S,
  REQUEST_TIMEOUT_ENV,
  EMPTY_SUMMARY_ERROR,
  summaryIsEmpty,
  type DatasourceFixture,
} from "./nlq_runner.ts";
import { getMetricsConfig } from "./metrics_config.ts";
import type { RunConfig } from "@tableau-ai-eval/core";
import type { FetchLike } from "@tableau-ai-eval/core";

// A no-wait rate limiter for tests: a huge rate so acquire() never blocks
// regardless of how many attempts a case makes (retries etc.).
const noWaitLimiter = () =>
  new RateLimiter({ rate: 1_000_000, sleep: async () => {} });

// ---------------------------------------------------------------------------
// Fixtures on disk (a couple of hand-written cases mirroring public-suites).
// ---------------------------------------------------------------------------

function makeSuiteDir(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "nlq-runner-"));
  const casesDir = join(root, "cases");
  mkdirSync(casesDir, { recursive: true });

  // A single-turn calc case.
  writeFileSync(
    join(casesDir, "calc_case.json"),
    JSON.stringify({
      runner: "ect-server",
      datasource: "public-activity-360",
      info: { provenance: "public" },
      inputs: [
        {
          utterance: "create a calc for day of week for Activity Date",
          source: "user",
          expected: {
            intent: "NLQ_TO_NEW_CALCULATED_FIELD",
            calculatedFieldFormula: {
              formula: "DATENAME('weekday', [Activity Date])",
              caption: null,
            },
          },
        },
      ],
      id: "calc-1",
    }),
  );

  // A two-turn viz case (follow-up → ids get :i suffixes).
  writeFileSync(
    join(casesDir, "viz_case.json"),
    JSON.stringify({
      runner: "ect-server",
      datasource: "public-opportunity-360",
      inputs: [
        {
          utterance: "total amount per Primary Product Family",
          expected: {
            intent: "NLQ_TO_NOTIONAL_SPEC",
            notionalSpec: {
              chart: "bar",
              fields: [{ caption: "Amount", encoding: "x", aggregation: "sum" }],
            },
          },
        },
        {
          utterance: "show median",
          expected: { intent: "NLQ_TO_NOTIONAL_SPEC" },
        },
      ],
      id: "viz-1",
    }),
  );

  return { dir: casesDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A canned CES conversations response for the calc case.
function cannedCalcResponse(): Record<string, unknown> {
  return {
    intentApplicationDetection: {
      result: {
        intent: "NLQ_TO_NEW_CALCULATED_FIELD",
        calculatedFieldFormula: {
          formula: "DATENAME('weekday', [Activity Date])",
          caption: "Day of Week",
        },
        _context: { some: "debug" },
      },
    },
    response: { content: "Here is a calc for the day of week." },
  };
}

// The REAL CES v4 conversations envelope for a calc, captured live: the
// generation lives at intentApplicationDetection.result.calculatedFieldFormula
// with {formula, caption, type}, and result.status === "OK" when the datasource
// is indexed. This is the shape the runner's find_sub_entry traversal must reach.
function realCalcResponse(): Record<string, unknown> {
  return {
    intentApplicationDetection: {
      intent: "NLQ_TO_NEW_CALCULATED_FIELD",
      confidence: 0.5,
      result: {
        status: "OK",
        notionalSpec: null,
        calc: null,
        calculatedFieldFormula: {
          formula: "DATENAME('weekday', [Activity Date])",
          caption: "Day of Week (Activity Date)",
          type: "",
        },
        calculatedFieldDescription:
          "This calculation extracts the day of the week from [Activity Date].",
        warnings: null,
        _context: null,
        steps: null,
        planId: "",
        unsupportedFeatures: "",
        hbiQuery: null,
        hbiResponse: null,
      },
    },
    response: {
      responseType: "GENERATION",
      content: "This calculation extracts the day of the week from [Activity Date].",
      id: "chatcmpl-abc",
    },
  };
}

// The un-indexed CES envelope: status NOT_PERFORMED, empty formula scaffold.
function unindexedCalcResponse(): Record<string, unknown> {
  return {
    intentApplicationDetection: {
      intent: "NLQ_TO_NEW_CALCULATED_FIELD",
      confidence: 0.5,
      result: {
        status: "NOT_PERFORMED",
        calculatedFieldFormula: { formula: "", caption: "", type: "" },
        calculatedFieldDescription:
          "I'm unable to create this calculation because the datasource contains no fields.",
        steps: null,
        _context: null,
      },
    },
    response: {
      responseType: "GENERATION",
      content: "the datasource contains no fields",
      id: "chatcmpl-xyz",
    },
  };
}

// A datasource fixture with the fields the calc references.
const activityFixture: DatasourceFixture = {
  fields: [
    { caption: "Activity Date", datatype: "date" },
    { caption: "Subject", datatype: "string" },
  ],
};

// A fetch that returns a canned 200 JSON body.
function fakeFetch(body: unknown, status = 200): FetchLike {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as FetchLike;
}

const baseConfig = (dir: string): RunConfig => ({
  test_path: dir,
  ces_url: "https://tab.example.com/content-exploration",
  metrics_file: "byollm_metrics",
  // No tableau creds → session is null (offline-friendly); the runner still
  // posts, and the fake fetch answers.
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("findSubEntry", () => {
  test("finds a key deep in the tree", () => {
    const tree = { a: { b: { intent: "X" } } };
    expect(findSubEntry(tree, "intent")).toBe("X");
  });
  test("returns null when absent", () => {
    expect(findSubEntry({ a: 1 }, "missing")).toBeNull();
  });
});

describe("parseCalcsFormula", () => {
  test("extracts bracketed fields; a date part is not a value", () => {
    const { fields, values } = parseCalcsFormula("DATENAME('weekday', [Activity Date])");
    expect(fields).toContain("Activity Date");
    expect(values).toEqual([]);
  });
  // Calculation validator integration
  // test_value_parser_counts_numbers_and_text_but_not_date_parts.
  test("counts numbers and text but not date parts", () => {
    const { fields, values, valueText } = parseCalcsFormula(
      "IF DATEPART('month', [Order Placed Date]) = 3 AND [Task Status] = 'Done' THEN [Amount] * 0.90 ELSE -1 END",
    );
    expect(new Set(fields)).toEqual(new Set(["Order Placed Date", "Task Status", "Amount"]));
    expect(new Set(values)).toEqual(new Set(["n:3", "s:done", "n:0.9", "n:1"]));
    expect(valueText["s:done"]).toBe("'Done'");
    expect(valueText["n:0.9"]).toBe("0.90");
  });
  test("empty formula yields empty sets", () => {
    expect(parseCalcsFormula(null)).toEqual({ fields: [], values: [], valueText: {} });
  });
});

describe("resolveFixturesDir", () => {
  test("explicit fixtures_dir wins", () => {
    expect(resolveFixturesDir({ fixtures_dir: "/some/dir" })).toBe("/some/dir");
  });

  test("public-suites layout: sibling fixtures/ of test_path", () => {
    const root = mkdtempSync(join(tmpdir(), "nlq-fixtures-public-"));
    try {
      mkdirSync(join(root, "fixtures"), { recursive: true });
      mkdirSync(join(root, "calcs", "cases"), { recursive: true });
      const dir = resolveFixturesDir({ test_path: join(root, "calcs", "cases") });
      expect(dir).toBe(join(root, "fixtures"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested layout: fixtures/table/ preferred over bare fixtures/", () => {
    // test-cases/<suite> + a separate top-level fixtures/table (submodule shape).
    const root = mkdtempSync(join(tmpdir(), "nlq-fixtures-submodule-"));
    try {
      mkdirSync(join(root, "test-cases", "calcs"), { recursive: true });
      mkdirSync(join(root, "fixtures", "table"), { recursive: true });
      const dir = resolveFixturesDir({
        test_path: join(root, "test-cases", "calcs"),
      });
      expect(dir).toBe(join(root, "fixtures", "table"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("null when no fixtures dir exists within the walk-up window", () => {
    const root = mkdtempSync(join(tmpdir(), "nlq-fixtures-none-"));
    try {
      mkdirSync(join(root, "cases"), { recursive: true });
      expect(resolveFixturesDir({ test_path: join(root, "cases") })).toBe(null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("getMetricsConfig", () => {
  test("byollm_metrics maps calc stages", () => {
    const cfg = getMetricsConfig("byollm_metrics", "ect-server");
    expect(cfg.calculatedFieldFormula?.map((m) => m.metric)).toContain("CalcValidity");
    expect(cfg.intent?.[0]?.metric).toBe("Equals");
  });
  test("strips path + extension", () => {
    const cfg = getMetricsConfig("./metrics_config/byollm_viz_metrics.json", "ect-server");
    expect(cfg.notionalSpec?.map((m) => m.metric)).toContain("SpecFieldValidity");
  });
});

describe("RateLimiter", () => {
  test("cancellation interrupts a queued rate-limit wait", async () => {
    const limiter = new RateLimiter({ rate: 1, sleep: () => new Promise(() => {}) });
    await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
  });
  test("allows up to rate within a window, then waits", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      rate: 2,
      windowMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms; // advance time so the loop makes progress
      },
    });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire(); // third must wait for the window
    expect(sleeps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadConversations
// ---------------------------------------------------------------------------

describe("loadConversations", () => {
  test("reads case files and builds conversations", () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({ rateLimiter: noWaitLimiter() });
      const convs = runner.loadConversations(baseConfig(dir));
      // Two files → two conversations.
      expect(convs.length).toBe(2);
      const calc = convs.find((c) => c[0]!.id === "calc-1")!;
      expect(calc).toBeDefined();
      expect(calc[0]!.runner).toBe("ect-server");
      expect(calc[0]!.datasource).toBe("public-activity-360");
      expect(calc[0]!.utterance).toContain("day of week");

      // The two-turn viz case gets :i-suffixed ids.
      const viz = convs.find((c) => c.length === 2)!;
      expect(viz.map((t) => t.id)).toEqual(["viz-1:0", "viz-1:1"]);
      expect(viz[1]!.turn).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("throws when test_path is missing", () => {
    const runner = new NlqHarnessRunner({ rateLimiter: noWaitLimiter() });
    expect(() => runner.loadConversations({})).toThrow(/test_path is required/);
  });

  test("throws when the dir has no cases", () => {
    const root = mkdtempSync(join(tmpdir(), "nlq-empty-"));
    try {
      const runner = new NlqHarnessRunner({ rateLimiter: noWaitLimiter() });
      expect(() => runner.loadConversations({ test_path: root })).toThrow(/no case files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("conversationFromFile", () => {
  test("single input keeps the base id", () => {
    const conv = conversationFromFile({
      id: "x",
      runner: "ect-server",
      datasource: "ds",
      inputs: [{ utterance: "u", expected: {} }],
    });
    expect(conv).toHaveLength(1);
    expect(conv[0]!.id).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// runCase — parsed actual shape + metrics, with injected fetch.
// ---------------------------------------------------------------------------

describe("runCase (offline, injected fetch)", () => {
  test("parses the per-stage actual shape and populates metrics", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch(cannedCalcResponse()),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const testCase = {
        id: "calc-1",
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "create a calc for day of week for Activity Date",
        expected: {
          intent: "NLQ_TO_NEW_CALCULATED_FIELD",
          calculatedFieldFormula: {
            formula: "DATENAME('weekday', [Activity Date])",
            caption: null,
          },
        },
      };
      const res = await runner.runCase(testCase, baseConfig(dir), []);

      // actual has the extracted per-stage entries.
      expect(res.actual?.intent).toBe("NLQ_TO_NEW_CALCULATED_FIELD");
      expect((res.actual?.calculatedFieldFormula as Record<string, unknown>).formula).toContain(
        "DATENAME",
      );
      // user_friendly_reply folded in for the judge.
      expect(res.actual?.user_friendly_reply).toContain("day of week");

      // metrics populated per stage.
      expect(res.metrics?.intent?.length).toBeGreaterThan(0);
      const intentEquals = res.metrics!.intent!.find((m) => m.metric_name === "equals");
      expect(intentEquals?.score).toBe(1.0); // intent matched exactly

      const calcMetrics = res.metrics!.calculatedFieldFormula!;
      expect(calcMetrics.map((m) => m.metric_name)).toContain("calcValidity");
      const validity = calcMetrics.find((m) => m.metric_name === "calcValidity");
      expect(validity?.score).toBe(1.0); // valid formula referencing a real field

      // no errors on a clean 200.
      expect(res.errors).toEqual([]);
      // latency captured (>= 0).
      expect(typeof res.latency).toBe("number");
    } finally {
      cleanup();
    }
  });

  test("a scoring exception is recorded on the case and does not kill the run", async () => {
    // A Color Palettes run died on its first case with KeyError: 'metric' from
    // the metric parser and produced no rows at all. The
    // answer was there; only the scoring failed — so that is what the case now
    // says, and the run goes on. Here we force the scoring stage to throw by
    // making the datasource lookup (read inside evaluate()) raise.
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch(cannedCalcResponse()),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => {
          throw new TypeError("boom");
        },
        // prepare() reads metadata (not the fixture), so indexing still succeeds.
        loadDatasourceMetadata: () => ({ fields: [] }) as never,
      });
      const testCase = {
        id: "calc-1",
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "create a calc for day of week for Activity Date",
        expected: {
          intent: "NLQ_TO_NEW_CALCULATED_FIELD",
          calculatedFieldFormula: {
            formula: "DATENAME('weekday', [Activity Date])",
            caption: null,
          },
        },
      };
      // Does not throw — the exception is recorded on the case.
      const res = await runner.runCase(testCase, baseConfig(dir), []);

      // The answer is kept (per-stage actual re-extracted from the response).
      expect(res.actual?.intent).toBe("NLQ_TO_NEW_CALCULATED_FIELD");
      expect(
        (res.actual?.calculatedFieldFormula as Record<string, unknown>).formula,
      ).toContain("DATENAME");
      // No metrics, one "Scoring failed: …" error on this case.
      expect(res.metrics).toEqual({});
      const scoring = (res.errors ?? []).filter((e) =>
        e.description.startsWith("Scoring failed:"),
      );
      expect(scoring.length).toBe(1);
      expect(scoring[0]!.phase).toBe("EVALUATE_RESULT");
      expect(scoring[0]!.description).toBe("Scoring failed: TypeError: boom");
    } finally {
      cleanup();
    }
  });

  test("extracts the calc formula from the REAL CES v4 envelope and scores calcValidity=1", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch(realCalcResponse()),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const testCase = {
        id: "calc-1",
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "create a calc containing the day of week for Activity Date",
        expected: {
          intent: "NLQ_TO_NEW_CALCULATED_FIELD",
          calculatedFieldFormula: {
            formula: "DATENAME('weekday', [Activity Date])",
            caption: null,
          },
        },
      };
      const res = await runner.runCase(testCase, baseConfig(dir), []);

      // The formula is pulled from intentApplicationDetection.result even
      // though the object carries a `type` field and sits under an extra
      // `intent`/`confidence`/`status` envelope. find_sub_entry reaches it.
      const cff = res.actual?.calculatedFieldFormula as Record<string, unknown>;
      expect(cff.formula).toBe("DATENAME('weekday', [Activity Date])");
      expect(cff.formula).not.toBe("");

      // calcValidity is 1.0 for the valid, parseable formula.
      const calcMetrics = res.metrics!.calculatedFieldFormula!;
      const validity = calcMetrics.find((m) => m.metric_name === "calcValidity");
      expect(validity?.score).toBe(1.0);

      // Field precision/recall are non-zero because the actual formula parses
      // to the same field set as expected ([Activity Date]).
      const fieldValidity = calcMetrics.find((m) => m.metric_name === "calcFieldValidity");
      expect(fieldValidity && fieldValidity.score).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("un-indexed datasource yields empty formula → calcValidity=0", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch(unindexedCalcResponse()),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const testCase = {
        id: "calc-1",
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "create a calc for day of week",
        expected: {
          intent: "NLQ_TO_NEW_CALCULATED_FIELD",
          calculatedFieldFormula: {
            formula: "DATENAME('weekday', [Activity Date])",
            caption: null,
          },
        },
      };
      const res = await runner.runCase(testCase, baseConfig(dir), []);
      const cff = res.actual?.calculatedFieldFormula as Record<string, unknown>;
      expect(cff.formula).toBe("");
      const validity = res.metrics!.calculatedFieldFormula!.find(
        (m) => m.metric_name === "calcValidity",
      );
      expect(validity?.score).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("prepare() indexes the datasource once (POST datasources + fields) and threads the ectId", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const calls: Array<{ url: string; body: unknown }> = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: String(url), body });
        if (String(url).endsWith("/analytics-assistant/datasources")) {
          return new Response(JSON.stringify({ datasourceECTId: "ect-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (String(url).includes("/datasources/") && String(url).endsWith("/fields")) {
          return new Response("{}", { status: 200 });
        }
        // conversations
        return new Response(JSON.stringify(realCalcResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as FetchLike;

      const runner = new NlqHarnessRunner({
        fetchImpl,
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
        loadDatasourceMetadata: () => ({
          datasourceIdentifier: "public-activity-360",
          name: "Activity 360",
          fields: [
            { name: "Activity Date", caption: "Activity Date", datatype: "date", count: 1, distinctCount: 1, values: ["2024-01-01"] },
          ],
        }),
      });
      const mkCase = (id: string) => ({
        id,
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "create a calc",
        expected: { intent: "NLQ_TO_NEW_CALCULATED_FIELD" },
      });

      await runner.runCase(mkCase("calc-1"), baseConfig(dir), []);
      await runner.runCase(mkCase("calc-2"), baseConfig(dir), []);

      // Indexing happened exactly once (idempotent): one datasources POST + one
      // fields POST, regardless of how many cases run.
      const dsPosts = calls.filter((c) =>
        c.url.endsWith("/analytics-assistant/datasources"),
      );
      const fieldPosts = calls.filter((c) => c.url.endsWith("/fields"));
      expect(dsPosts.length).toBe(1);
      expect(fieldPosts.length).toBe(1);
      // The datasource metadata carries fields without inline value samples
      // (values were split into the fields payload).
      const dsBody = dsPosts[0]!.body as { datasourceMetadata: { fields: Array<Record<string, unknown>> } };
      // ... and without the sample statistics: the server's metadata model
      // declares neither, and its 2026-10-30 build rejects unknown keys.
      expect(dsBody.datasourceMetadata.fields[0]).toEqual({ name: "Activity Date", caption: "Activity Date", datatype: "date" });
      const fieldBody = fieldPosts[0]!.body as { fields: Array<Record<string, unknown>> };
      expect(fieldBody.fields[0]!.values).toEqual(["2024-01-01"]);

      // The conversations POST used the captured datasourceECTId.
      const convPost = calls.find((c) =>
        c.url.endsWith("/analytics-assistant/conversations"),
      )!;
      expect((convPost.body as { datasourceECTId: string }).datasourceECTId).toBe("ect-123");
      // The calculation context carries only the keys the server's model declares (no `errorPosition`).
      expect((convPost.body as { applicationContext: { calculationContext: unknown } }).applicationContext.calculationContext)
        .toEqual({ formula: null, caption: "", errorMessages: [] });
    } finally {
      cleanup();
    }
  });

  test("captures a 500 as an error instead of throwing", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch({ message: "boom" }, 500),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const testCase = {
        id: "calc-1",
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "make a calc",
        expected: { intent: "NLQ_TO_NEW_CALCULATED_FIELD" },
      };
      const res = await runner.runCase(testCase, baseConfig(dir), []);
      expect(res.errors?.length).toBeGreaterThan(0);
      expect(res.errors![0]!.description).toMatch(/Bad response \(500\)/);
      expect(res.actual).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("a request the server never answers times out, is retried, and is named", async () => {
    // With no limit a lost request can sit for minutes.
    const { dir, cleanup } = makeSuiteDir();
    const prev = process.env[REQUEST_TIMEOUT_ENV];
    process.env[REQUEST_TIMEOUT_ENV] = "0.05";
    let calls = 0;
    // Never answers; rejects only when the request's own signal fires.
    const hang = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
      });
    }) as unknown as FetchLike;
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: hang,
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const res = await runner.runCase(
        {
          id: "calc-1",
          runner: "ect-server",
          datasource: "public-activity-360",
          utterance: "make a calc",
          expected: { intent: "NLQ_TO_NEW_CALCULATED_FIELD" },
        },
        baseConfig(dir),
        [],
      );
      // The datasource registration is the first request: three attempts.
      expect(calls).toBe(3);
      const text = JSON.stringify(res.errors);
      expect(text).toContain("no answer from the server within 0.05 s");
    } finally {
      if (prev === undefined) delete process.env[REQUEST_TIMEOUT_ENV];
      else process.env[REQUEST_TIMEOUT_ENV] = prev;
      cleanup();
    }
  });

  test("requestTimeoutS: default, positive override, junk ignored", () => {
    const prev = process.env[REQUEST_TIMEOUT_ENV];
    try {
      delete process.env[REQUEST_TIMEOUT_ENV];
      expect(requestTimeoutS()).toBe(DEFAULT_REQUEST_TIMEOUT_S);
      expect(DEFAULT_REQUEST_TIMEOUT_S).toBe(120);
      process.env[REQUEST_TIMEOUT_ENV] = "300";
      expect(requestTimeoutS()).toBe(300);
      for (const junk of ["0", "-5", "soon"]) {
        process.env[REQUEST_TIMEOUT_ENV] = junk;
        expect(requestTimeoutS()).toBe(120);
      }
    } finally {
      if (prev === undefined) delete process.env[REQUEST_TIMEOUT_ENV];
      else process.env[REQUEST_TIMEOUT_ENV] = prev;
    }
  });

  test("errors when ces_url is absent", async () => {
    const runner = new NlqHarnessRunner({
      fetchImpl: fakeFetch(cannedCalcResponse()),
      rateLimiter: noWaitLimiter(),
    });
    const res = await runner.runCase(
      {
        id: "calc-1",
        runner: "ect-server",
        datasource: "ds",
        utterance: "u",
        expected: { intent: "X" },
      },
      { test_path: "/tmp/nope" },
      [],
    );
    expect(res.errors?.[0]?.description).toMatch(/ces_url is required/);
  });

  // A canned CES calc response whose _context.opensearch_query.matched carries
  // matched fields (chunk + flat), so the ect-server "context" metrics
  // (SemanticSearchAccuracy / FieldRankScorer) have something to score. The
  // formula references [Activity Date], which the matched list includes.
  function calcResponseWithContext(): Record<string, unknown> {
    return {
      intentApplicationDetection: {
        result: {
          intent: "NLQ_TO_NEW_CALCULATED_FIELD",
          calculatedFieldFormula: {
            formula: "DATENAME('weekday', [Activity Date])",
            caption: "Day of Week",
          },
          _context: {
            opensearch_query: {
              matched: [
                {
                  chunk: "chunk-1",
                  matches: [
                    { fieldName: "Activity Date", score: 0.95, filtered: false },
                    { fieldName: "Subject", score: 0.4, filtered: false },
                  ],
                },
                { fieldName: "Activity Date" },
              ],
            },
          },
        },
      },
      response: { content: "Here is a calc for the day of week." },
    };
  }

  test("context metrics: _context.opensearch_query.matched flows into scoring", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch(calcResponseWithContext()),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const testCase = {
        id: "calc-1",
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "create a calc for day of week for Activity Date",
        expected: {
          intent: "NLQ_TO_NEW_CALCULATED_FIELD",
          calculatedFieldFormula: {
            formula: "DATENAME('weekday', [Activity Date])",
            caption: null,
          },
        },
      };
      // metrics_file "metrics" (METRICS_FULL) wires SemanticSearchAccuracy +
      // FieldRankScorer onto the calculatedFieldFormula stage.
      const res = await runner.runCase(
        testCase,
        { ...baseConfig(dir), metrics_file: "metrics" },
        [],
      );

      const calcMetrics = res.metrics!.calculatedFieldFormula!;
      const names = calcMetrics.map((m) => m.metric_name);

      // The context metrics are PRESENT (not skipped) because _context carried
      // matched fields threaded into data["semanticsearch_results"].
      expect(names).toContain("semanticSearchAccuracy");
      // FieldRankScorer emits fRank_* (chunk present -> qrels/run non-empty).
      expect(names.some((n) => n.startsWith("fRank_"))).toBe(true);

      // SemanticSearchAccuracy: expected fields {Activity Date} all matched -> 1.0.
      const ssa = calcMetrics.find((m) => m.metric_name === "semanticSearchAccuracy");
      expect(ssa?.score).toBe(1.0);

      // FieldRankScorer: Activity Date is the top-ranked match in chunk-1 -> hit@1=1.
      const fr1 = calcMetrics.find((m) => m.metric_name === "fRank_hit_rate@1");
      expect(fr1?.score).toBe(1.0);

      // The runner hands the serializer what the server matched.
      expect(Array.isArray(res.evaluatorData?.semanticsearch_results)).toBe(true);
      expect(res.evaluatorData?.datasource_fields).toHaveLength(activityFixture.fields.length);
    } finally {
      cleanup();
    }
  });

  test("context metrics: empty/absent _context still scores the non-context path identically (no regression)", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      // cannedCalcResponse carries _context:{some:"debug"} (no opensearch_query),
      // so semanticsearchResults is null and the context metrics are skipped.
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch(cannedCalcResponse()),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const testCase = {
        id: "calc-1",
        runner: "ect-server",
        datasource: "public-activity-360",
        utterance: "create a calc for day of week for Activity Date",
        expected: {
          intent: "NLQ_TO_NEW_CALCULATED_FIELD",
          calculatedFieldFormula: {
            formula: "DATENAME('weekday', [Activity Date])",
            caption: null,
          },
        },
      };

      // Score with the full config (context metrics wired) …
      const full = await runner.runCase(
        testCase,
        { ...baseConfig(dir), metrics_file: "metrics" },
        [],
      );
      const fullCalc = full.metrics!.calculatedFieldFormula!;

      // SemanticSearchAccuracy still emits (parsedExpectedFields non-empty,
      // matched empty -> 0.0). FieldRankScorer emits [] (no chunk -> qrels
      // empty -> Python returns []). Assert that shape.
      const ssa = fullCalc.find((m) => m.metric_name === "semanticSearchAccuracy");
      expect(ssa?.score).toBe(0.0);
      expect(fullCalc.some((m) => m.metric_name.startsWith("fRank_"))).toBe(false);

      // … and the NON-context calc metrics (calcValidity + field/value accuracy)
      // are identical to the byollm_metrics path that never touches _context.
      const runner2 = new NlqHarnessRunner({
        fetchImpl: fakeFetch(cannedCalcResponse()),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => activityFixture,
      });
      const base = await runner2.runCase(
        testCase,
        { ...baseConfig(dir), metrics_file: "byollm_metrics" },
        [],
      );
      const baseCalc = base.metrics!.calculatedFieldFormula!;

      const pick = (list: typeof baseCalc, name: string) =>
        list.find((m) => m.metric_name === name)?.score;
      for (const name of [
        "calcValidity",
        "calcFieldValidity",
        "fieldPrecision",
        "fieldRecall",
        "valuePrecision",
        "valueRecall",
      ]) {
        expect(pick(fullCalc, name)).toBe(pick(baseCalc, name));
      }
    } finally {
      cleanup();
    }
  });

  test("viz notionalSpec stage emits the tool's viz-quality metrics", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const vizResponse = {
        intentApplicationDetection: {
          result: {
            intent: "NLQ_TO_NOTIONAL_SPEC",
            notionalSpec: {
              chart: "bar",
              fields: [{ caption: "Amount", encoding: "x", aggregation: "sum" }],
            },
          },
        },
        response: { content: "A bar chart." },
      };
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch(vizResponse),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => ({ fields: [{ caption: "Amount", datatype: "number" }] }),
      });
      const res = await runner.runCase(
        {
          id: "viz-1",
          runner: "ect-server",
          datasource: "public-opportunity-360",
          utterance: "total amount per Primary Product Family",
          expected: {
            intent: "NLQ_TO_NOTIONAL_SPEC",
            notionalSpec: {
              chart: "bar",
              fields: [{ caption: "Amount", encoding: "x", aggregation: "sum" }],
            },
          },
        },
        { ...baseConfig(dir), metrics_file: "byollm_viz_metrics" },
        [],
      );
      expect(res.metrics?.vizQuality?.length).toBeGreaterThan(0);
      const chartSim = res.metrics!.vizQuality!.find((m) => m.metric_name === "chartSimilarity");
      expect(chartSim?.score).toBe(1.0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Colour palettes: the deterministic palette checks run on the colorPalette
// stage, keyed by the requested palette type; the LLM rubric (valid/relevance/
// design) is left to the BYOK judge (attached by the orchestrator).
// ---------------------------------------------------------------------------

describe("colour-palette scoring", () => {
  // The palette generate endpoint returns {colors}, mapped to {colorPalette}.
  const paletteReply = (colors: string[]) =>
    new Response(JSON.stringify({ colors }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;

  const paletteConfig = (dir: string): RunConfig => ({
    test_path: dir,
    ces_url: "https://tab.example.com/content-exploration",
    metrics_file: "byollm_palette_metrics",
  });

  test("getMetricsConfig(byollm_palette_metrics) is the four deterministic checks", () => {
    const cfg = getMetricsConfig("byollm_palette_metrics", "color-palettes-server");
    expect(cfg.colorPalette?.map((m) => m.metric)).toEqual([
      "ColorPaletteDistinguishability",
      "GradientSmoothness",
      "DivergingPaletteStructure",
      "GroundTruthColorPaletteEvaluation",
    ]);
  });

  test("posts {utterance, paletteType} to the palette generate endpoint", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: (async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
          return paletteReply(["#08306b", "#f7f7f7", "#7f0000"]);
        }) as unknown as FetchLike,
        rateLimiter: noWaitLimiter(),
        sessionFactory: () => null,
      });
      await runner.runCase(
        {
          id: "pal-req",
          runner: "color-palettes-server",
          datasource: null,
          utterance: "temperature",
          turn: 0,
          expected: { colorPalette: [] },
          paletteType: "diverging",
        },
        paletteConfig(dir),
        [],
      );
      // A single POST to the palette endpoint — no datasource index, no convo.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(
        "https://tab.example.com/content-exploration/analytics-assistant/color-palettes/generate",
      );
      expect(calls[0]!.body).toEqual({
        utterance: { content: "temperature" },
        paletteType: "diverging",
      });
    } finally {
      cleanup();
    }
  });

  test("a diverging palette case scores the diverging structure metric, no judge metric", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: (async () => paletteReply(["#08306b", "#f7f7f7", "#7f0000"])) as unknown as FetchLike,
        rateLimiter: noWaitLimiter(),
        sessionFactory: () => null,
      });
      const res = await runner.runCase(
        {
          id: "pal-1",
          runner: "color-palettes-server",
          datasource: null,
          utterance: "temperature",
          turn: 0,
          expected: { colorPalette: [] },
          paletteType: "diverging",
        },
        paletteConfig(dir),
        [],
      );
      // The {colors} response maps to {colorPalette}.
      expect(res.actual?.colorPalette).toEqual(["#08306b", "#f7f7f7", "#7f0000"]);
      const names = (res.metrics?.colorPalette ?? []).map((m) => m.metric_name);
      // diverging → GradientSmoothness + DivergingPaletteStructure fire;
      // distinguishability is regular-only so it produces nothing here.
      expect(names).toContain("divergingStructure");
      expect(names).toContain("gradientSmoothness");
      // No LLM-scored dimensions on the deterministic path.
      expect(names).not.toContain("valid");
      expect(names).not.toContain("relevance");
      expect(names).not.toContain("design");
    } finally {
      cleanup();
    }
  });

  test("a regular palette case scores distinguishability", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: (async () => paletteReply(["#e41a1c", "#377eb8", "#4daf4a"])) as unknown as FetchLike,
        rateLimiter: noWaitLimiter(),
        sessionFactory: () => null,
      });
      const res = await runner.runCase(
        {
          id: "pal-2",
          runner: "color-palettes-server",
          datasource: null,
          utterance: "three distinct categories",
          turn: 0,
          expected: { colorPalette: [] },
          paletteType: "regular",
        },
        paletteConfig(dir),
        [],
      );
      const names = (res.metrics?.colorPalette ?? []).map((m) => m.metric_name);
      expect(names).toContain("distinguishability");
    } finally {
      cleanup();
    }
  });
});


// ---------------------------------------------------------------------------
// Dashboard summaries: an empty summary is a failed case.
// 33507d1b, `_summary_is_empty` / `_fail_empty_summary`).
// ---------------------------------------------------------------------------

describe("Dashboard summaries: an empty summary is a failed case", () => {
  test("what counts as an empty summary", () => {
    const empty = summaryIsEmpty;
    expect(empty({ insightNarrative: null })).toBe(true);
    expect(empty({ insightNarrative: "  " })).toBe(true);
    expect(empty({ insightNarrative: '{\n  "sections" : [ ]\n}' })).toBe(true); // what the server sends
    expect(empty({ insightNarrative: '{"sections": [{"title": "", "children": []}]}' })).toBe(true);
    expect(empty({ insightNarrative: "Sales rose in the West." })).toBe(false); // plain text
    expect(empty({ insightNarrative: '{"sections": [{"title": "Overview", "text": "Sales rose."}]}' })).toBe(false);
    expect(empty({ calculatedFieldFormula: "SUM([Sales])" })).toBe(false); // another capability
    expect(empty({})).toBe(false); // a failed request is not this
  });

  const narrativeCase = {
    id: "dn-1",
    runner: "dashboard-viz-narrative-config",
    datasource: null,
    utterance: "Dashboard Name: Splits Overview",
    arguments: { dashboardName: "Splits Overview", dashboardId: "splits", dashboardArtifacts: [], views: [] },
    expected: { insightNarrative: '{"sections": [{"text": "Sales rose."}]}' },
  };

  test("an empty summary is not scored and carries the reason", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch({ insightNarrative: '{"sections": []}' }),
        rateLimiter: noWaitLimiter(),
      });
      const res = await runner.runCase(narrativeCase as never, baseConfig(dir), []);
      expect(res.actual).toEqual({}); // no answer: the run counts it as failed
      expect(res.metrics).toEqual({});
      expect(res.errors?.map((e) => e.description)).toEqual([EMPTY_SUMMARY_ERROR]);
      expect(res.errors?.[0]?.phase).toBe("RUN_TEST");
    } finally {
      cleanup();
    }
  });

  test("a real summary is scored as before", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fakeFetch({ insightNarrative: '{"sections": [{"text": "Sales rose."}]}' }),
        rateLimiter: noWaitLimiter(),
      });
      const res = await runner.runCase(narrativeCase as never, baseConfig(dir), []);
      expect(res.errors?.map((e) => e.description)).not.toContain(EMPTY_SUMMARY_ERROR);
      expect(res.actual?.insightNarrative).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// A follow-up answered without a chart: the previous chart stands
// ---------------------------------------------------------------------------

describe("a chart request answered without a chart", () => {
  const chart = {
    chart: "bar",
    fields: [{ caption: "Region", encoding: "x" }, { caption: "Sales", encoding: "y", aggregation: "sum" }],
    categoricalFilters: [{ type: "categorical", field: "Region", values: ["West"] }],
  };
  const expected = { intent: "NLQ_TO_NOTIONAL_SPEC", notionalSpec: chart };
  const chartReply = {
    intentApplicationDetection: { intent: "NLQ_TO_NOTIONAL_SPEC", result: { intent: "NLQ_TO_NOTIONAL_SPEC", notionalSpec: chart } },
    response: { content: "Sales by region, West only." },
  };
  const unchangedReply = {
    intentApplicationDetection: { intent: "NLQ_TO_NOTIONAL_SPEC", result: { intent: "NLQ_TO_NOTIONAL_SPEC" } },
    response: { content: "West is already the only region shown." },
  };
  const formulaReply = {
    intentApplicationDetection: {
      intent: "NLQ_TO_NEW_CALCULATED_FIELD",
      result: { intent: "NLQ_TO_NEW_CALCULATED_FIELD", calculatedFieldFormula: { formula: "SUM([Sales])", caption: "Total" } },
    },
    response: { content: "Here is a calculation." },
  };
  const fetchInOrder = (bodies: unknown[]): FetchLike => {
    let i = 0;
    return (async () =>
      new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as FetchLike;
  };
  const turn = (id: string, utterance: string, isEnd = false) => ({
    id,
    runner: "ect-server",
    datasource: "public-opportunity-360",
    utterance,
    expected,
    isEnd,
  });
  const vizScores = (res: { metrics?: Record<string, { metric_name: string; score: number | null; explanation?: string | null }[]> }) =>
    Object.fromEntries((res.metrics?.vizQuality ?? []).map((m) => [m.metric_name, m]));

  test("is scored on the chart that stands, which the row records", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fetchInOrder([chartReply, unchangedReply]),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => ({ fields: [{ caption: "Region", datatype: "string" }, { caption: "Sales", datatype: "number" }] }),
      });
      const config = { ...baseConfig(dir), metrics_file: "byollm_viz_metrics", adapter: "agent" };
      await runner.runCase(turn("conv:0", "sales by region, West only"), config, []);
      const res = await runner.runCase(turn("conv:1", "also include West", true), config, []);
      expect(res.actual!.notionalSpec ?? null).toBeNull();
      expect(res.actual!.unchanged_chart).toEqual(chart);
      const scores = vizScores(res);
      expect(scores.fieldSimilarity!.score).toBe(1.0);
      expect(scores.filterAccuracy!.score).toBe(1.0);
      expect(scores.filterAccuracy!.explanation!.startsWith("The model left the chart as it was")).toBe(true);
      const spec = Object.fromEntries((res.metrics?.notionalSpec ?? []).map((m) => [m.metric_name, m.score]));
      expect(spec.recall).toBe(1.0);
    } finally {
      cleanup();
    }
  });

  test("is no chart on a first turn or with another intent", async () => {
    const { dir, cleanup } = makeSuiteDir();
    try {
      const runner = new NlqHarnessRunner({
        fetchImpl: fetchInOrder([unchangedReply, chartReply, formulaReply]),
        rateLimiter: noWaitLimiter(),
        loadDatasource: () => ({ fields: [{ caption: "Region", datatype: "string" }, { caption: "Sales", datatype: "number" }] }),
      });
      const config = { ...baseConfig(dir), metrics_file: "byollm_viz_metrics", adapter: "agent" };
      const first = await runner.runCase(turn("alone", "sales by region"), config, []);
      expect(first.actual!.unchanged_chart).toBeUndefined();
      expect(vizScores(first).fieldSimilarity!.score).toBe(0.0);
      await runner.runCase(turn("other:0", "sales by region, West only"), config, []);
      const wrongIntent = await runner.runCase(turn("other:1", "as a formula", true), config, []);
      expect(wrongIntent.actual!.unchanged_chart).toBeUndefined();
      expect(vizScores(wrongIntent).fieldSimilarity!.score).toBe(0.0);
    } finally {
      cleanup();
    }
  });
});
