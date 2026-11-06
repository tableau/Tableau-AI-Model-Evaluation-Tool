import { describe, expect, test } from "bun:test";
import {
  createNlqAdapter,
  executeConversations,
  serializeCase,
  type HarnessCase,
  type HarnessCaseResult,
  type HarnessConversation,
  type HarnessRunner,
} from "./nlq.ts";
import { resolveMaxConcurrency, resolveRequestsPerMinute } from "@tableau-ai-eval/core";
import type { RowPayload } from "@tableau-ai-eval/core";

/** A fake harness that returns fixed conversations + synthetic per-case results. */
function fakeRunner(conversations: HarnessConversation[]): HarnessRunner & {
  ranIds: string[];
} {
  const ranIds: string[] = [];
  return {
    ranIds,
    loadConversations() {
      return conversations;
    },
    runCase(c: HarnessCase, _config, prefixes): HarnessCaseResult {
      ranIds.push(c.id);
      const utterance = prefixes.length ? [...prefixes, c.utterance].join(" ") : c.utterance;
      return {
        actual: { user_friendly_reply: `answer to ${utterance}` },
        latency: 1.5,
        errors: [],
        metrics: {
          default: [
            { metric_id: "Equals", metric_name: "equals", score: 1.0, explanation: null },
          ],
        },
        debugInfo: { echoed: utterance },
        info: {},
      };
    },
  };
}

const CONVERSATIONS: HarnessConversation[] = [
  [
    { id: "c1.t0", runner: "viz", datasource: "ds1", utterance: "hi", turn: 0, expected: { a: 1 } },
    { id: "c1.t1", runner: "viz", datasource: "ds1", utterance: "more", turn: 1, expected: {} },
  ],
  [{ id: "c2.t0", runner: "viz", datasource: "ds2", utterance: "solo", turn: 0, expected: {} }],
];

describe("nlq adapter — suite plan", () => {
  test("totals, skeletons, and conversation_ids shape", async () => {
    const adapter = createNlqAdapter({ harnessRunner: fakeRunner(CONVERSATIONS) });
    const plan = await adapter.load({});
    expect(plan.total).toBe(3);
    expect(plan.skeletons).toHaveLength(3);
    expect(plan.skeletons[0]).toEqual({
      test_case_id: "c1.t0",
      runner: "viz",
      datasource: "ds1",
      utterance: "hi",
      expected: { a: 1 },
    });
    expect(plan.conversation_ids).toEqual([["c1.t0", "c1.t1"], ["c2.t0"]]);
  });

  test("load throws when no cases", async () => {
    const adapter = createNlqAdapter({ harnessRunner: fakeRunner([]) });
    await expect(adapter.load({})).rejects.toThrow(/No runnable test cases/);
  });
});

describe("nlq adapter — emit_case normalization", () => {
  test("row payload has the full contract shape", async () => {
    const adapter = createNlqAdapter({ harnessRunner: fakeRunner(CONVERSATIONS) });
    const plan = await adapter.load({});
    const rows: RowPayload[] = [];
    await adapter.execute(plan, {}, async (r) => void rows.push(r), () => null, new Set());

    expect(rows).toHaveLength(3);
    const r = rows[0]!;
    expect(r.test_case_id).toBe("c1.t0");
    expect(r.runner).toBe("viz");
    expect(r.datasource).toBe("ds1");
    expect(r.utterance).toBe("hi");
    expect(r.turn).toBe(0);
    expect(r.expected).toEqual({ a: 1 });
    expect(r.actual).toEqual({ user_friendly_reply: "answer to hi" });
    expect(r.latency).toBe(1.5);
    expect(r.errors).toEqual([]);
    expect(r.metrics.default![0]!.metric_name).toBe("equals");
    expect(r.debug_info).toEqual({ echoed: "hi" });
    expect(r.info).toEqual({});
  });

  test("prefixes are prepended to the utterance the runner sees", async () => {
    const runner = fakeRunner(CONVERSATIONS);
    const adapter = createNlqAdapter({ harnessRunner: runner });
    const plan = await adapter.load({});
    const rows: RowPayload[] = [];
    await adapter.execute(
      plan,
      { prefixes: ["PFX"] },
      async (r) => void rows.push(r),
      () => null,
      new Set(),
    );
    expect(rows[0]!.actual).toEqual({ user_friendly_reply: "answer to PFX hi" });
  });
});

describe("nlq adapter — resume skip at conversation granularity", () => {
  test("skips a conversation only when EVERY case id is completed", async () => {
    const runner = fakeRunner(CONVERSATIONS);
    const adapter = createNlqAdapter({ harnessRunner: runner });
    const plan = await adapter.load({});
    const rows: RowPayload[] = [];
    // c1 fully completed; c2 not.
    const completed = new Set(["c1.t0", "c1.t1"]);
    await adapter.execute(plan, {}, async (r) => void rows.push(r), () => null, completed);
    expect(runner.ranIds).toEqual(["c2.t0"]);
    expect(rows.map((r) => r.test_case_id)).toEqual(["c2.t0"]);
  });

  test("does NOT skip a conversation with only partial completion", async () => {
    const runner = fakeRunner(CONVERSATIONS);
    const adapter = createNlqAdapter({ harnessRunner: runner });
    const plan = await adapter.load({});
    const rows: RowPayload[] = [];
    // Only c1.t0 completed — the whole c1 conversation must re-run in full.
    const completed = new Set(["c1.t0"]);
    // With conversations running concurrently, completion order interleaves
    // The SET
    // of cases run is what matters, and turns within a conversation stay ordered.
    await adapter.execute(plan, {}, async (r) => void rows.push(r), () => null, completed);
    expect([...runner.ranIds].sort()).toEqual(["c1.t0", "c1.t1", "c2.t0"]);
    // c1's turns kept their order relative to each other.
    expect(runner.ranIds.indexOf("c1.t1")).toBeGreaterThan(runner.ranIds.indexOf("c1.t0"));
  });

  test("TABLEAU_AI_EVAL_MAX_CONCURRENCY=1 restores the old strict sequential order", async () => {
    const prev = process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
    process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = "1";
    try {
      const runner = fakeRunner(CONVERSATIONS);
      const adapter = createNlqAdapter({ harnessRunner: runner });
      const plan = await adapter.load({});
      const rows: RowPayload[] = [];
      await adapter.execute(plan, {}, async (r) => void rows.push(r), () => null, new Set(["c1.t0"]));
      expect(runner.ranIds).toEqual(["c1.t0", "c1.t1", "c2.t0"]);
    } finally {
      if (prev === undefined) delete process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
      else process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = prev;
    }
  });
});

describe("nlq adapter — should_stop", () => {
  test("nothing new starts after a control request (bounded by concurrency)", async () => {
    // With conversations running concurrently, a pause lands within about one
    // case's latency: nothing new starts once should_stop reports a request,
    // and the conversations already in flight finish. Covers
    // `test_nothing_new_starts_after_a_pause_request`.
    const many: HarnessConversation[] = Array.from({ length: 20 }, (_, i) => [
      { id: `s${i}.t0`, runner: "viz", datasource: "ds", utterance: `u${i}`, turn: 0, expected: {} },
    ]);
    const runner = fakeRunner(many);
    const adapter = createNlqAdapter({ harnessRunner: runner });
    const plan = await adapter.load({});
    const rows: RowPayload[] = [];
    let emitted = 0;
    const shouldStop = () => (emitted >= 4 ? "pause" : null);
    await adapter.execute(
      plan,
      {},
      async (r) => {
        rows.push(r);
        emitted += 1;
      },
      shouldStop,
      new Set(),
    );
    // The 4 emitted before the request, plus at most the (default 3) already
    // in flight; never the whole suite.
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.length).toBeLessThanOrEqual(7);
  });

  test("halts scheduling new cases when should_stop returns non-null (sequential)", async () => {
    const prev = process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
    process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = "1";
    try {
      const runner = fakeRunner(CONVERSATIONS);
      const adapter = createNlqAdapter({ harnessRunner: runner });
      const plan = await adapter.load({});
      const rows: RowPayload[] = [];
      let emitted = 0;
      // Stop after the first emitted case.
      const shouldStop = () => (emitted >= 1 ? "pause" : null);
      await adapter.execute(
        plan,
        {},
        async (r) => {
          rows.push(r);
          emitted += 1;
        },
        shouldStop,
        new Set(),
      );
      // First case emitted, then the boundary check halts the run.
      expect(rows).toHaveLength(1);
      expect(runner.ranIds).toEqual(["c1.t0"]);
    } finally {
      if (prev === undefined) delete process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
      else process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = prev;
    }
  });

  test("stops before running any case if should_stop is set up front", async () => {
    const runner = fakeRunner(CONVERSATIONS);
    const adapter = createNlqAdapter({ harnessRunner: runner });
    const plan = await adapter.load({});
    await adapter.execute(plan, {}, async () => {}, () => "cancel", new Set());
    expect(runner.ranIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The bounded conversation scheduler:
// conversations run up to max_concurrency at a time; the invariants below keep
// pause/resume and the event stream correct while they do.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function schedulerConversations(n: number, turns = 1): HarnessConversation[] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: turns }, (_, t) => ({
      id: `c${i}-t${t}`,
      runner: "r",
      datasource: "ds",
      utterance: `q ${i}.${t}`,
      turn: t,
      expected: {},
    })),
  );
}

/** A conversation runner that tracks in-flight/peak and records order. */
function trackingRunner(delayMs = 5) {
  const state = { inFlight: 0, peak: 0, order: [] as string[] };
  const run = async (conversation: HarnessConversation): Promise<void> => {
    for (const c of conversation) {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      state.order.push(c.id);
      await sleep(delayMs * (0.5 + Math.random()));
      state.inFlight -= 1;
    }
  };
  return { state, run };
}

describe("nlq adapter — bounded scheduler", () => {
  test("in-flight never exceeds max_concurrency and every case runs", async () => {
    const { state, run } = trackingRunner();
    await executeConversations(schedulerConversations(12), run, () => null, new Set(), 3);
    expect([...state.order].sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `c${i}-t0`).sort(),
    );
    expect(state.peak).toBeLessThanOrEqual(3);
    expect(state.peak).toBeGreaterThanOrEqual(2); // it did actually overlap
  });

  test("concurrency 1 is the old sequential order", async () => {
    const { state, run } = trackingRunner();
    await executeConversations(schedulerConversations(6), run, () => null, new Set(), 1);
    expect(state.order).toEqual(Array.from({ length: 6 }, (_, i) => `c${i}-t0`));
    expect(state.peak).toBe(1);
  });

  test("turns inside a conversation stay in order", async () => {
    const { state, run } = trackingRunner();
    await executeConversations(schedulerConversations(4, 3), run, () => null, new Set(), 4);
    for (let i = 0; i < 4; i++) {
      const turns = state.order.filter((id) => id.startsWith(`c${i}-`));
      expect(turns).toEqual([`c${i}-t0`, `c${i}-t1`, `c${i}-t2`]);
    }
  });

  test("completed conversations are skipped", async () => {
    const { state, run } = trackingRunner();
    const done = new Set(["c0-t0", "c1-t0"]);
    await executeConversations(schedulerConversations(5), run, () => null, done, 3);
    expect([...state.order].sort()).toEqual(["c2-t0", "c3-t0", "c4-t0"]);
  });

  test("a runner exception is raised after the others drain", async () => {
    const conversations = schedulerConversations(5);
    const seen: string[] = [];
    const run = async (conversation: HarnessConversation): Promise<void> => {
      for (const c of conversation) {
        if (c.id === "c1-t0") throw new Error("boom");
        await sleep(2);
        seen.push(c.id);
      }
    };
    await expect(
      executeConversations(conversations, run, () => null, new Set(), 2),
    ).rejects.toThrow("boom");
    // The rest still completed on the way out (no row lost).
    expect(seen.sort()).toEqual(["c0-t0", "c2-t0", "c3-t0", "c4-t0"]);
  });

  test("each case is announced when it starts and never more than run at once", async () => {
    // The results page shows a case as running from this call until its row
    // arrives; the cases behind the concurrency bound stay queued (
    // 37f79cf2 test_each_case_is_announced_when_it_starts...).
    const many = schedulerConversations(8);
    const base = fakeRunner(many);
    const runner: HarnessRunner = {
      loadConversations: base.loadConversations,
      async runCase(c, config, prefixes) {
        await sleep(3 * (0.5 + Math.random()));
        return base.runCase(c, config, prefixes);
      },
    };
    const prev = process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
    process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = "3";
    try {
      const adapter = createNlqAdapter({ harnessRunner: runner });
      const plan = await adapter.load({});
      const emitted: string[] = [];
      const started: string[] = [];
      let peak = 0;
      plan.case_started = (id) => {
        expect(emitted).not.toContain(id); // before its row
        started.push(id);
        peak = Math.max(peak, started.filter((s) => !emitted.includes(s)).length);
      };
      await adapter.execute(plan, {}, async (r) => void emitted.push(r.test_case_id), () => null, new Set());
      const all = Array.from({ length: 8 }, (_, i) => `c${i}-t0`).sort();
      expect([...started].sort()).toEqual(all);
      expect([...emitted].sort()).toEqual(all);
      expect(peak).toBeLessThanOrEqual(3);
    } finally {
      if (prev === undefined) delete process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
      else process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = prev;
    }
  });
});

describe("concurrency / rate settings resolution", () => {
  test("resolveMaxConcurrency: default, run value, clamp, env kill switch", () => {
    const prev = process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
    delete process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
    try {
      expect(resolveMaxConcurrency({})).toBe(3);
      expect(resolveMaxConcurrency({ max_concurrency: 5 })).toBe(5);
      expect(resolveMaxConcurrency({ max_concurrency: 0 })).toBe(1);
      expect(resolveMaxConcurrency({ max_concurrency: "99" })).toBe(16);
      process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = "1";
      expect(resolveMaxConcurrency({ max_concurrency: 5 })).toBe(1); // env wins
    } finally {
      if (prev === undefined) delete process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
      else process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = prev;
    }
  });

  test("resolveRequestsPerMinute: null default, clamp", () => {
    expect(resolveRequestsPerMinute({})).toBeNull();
    expect(resolveRequestsPerMinute({ requests_per_minute: 12 })).toBe(12);
    expect(resolveRequestsPerMinute({ requests_per_minute: 500 })).toBe(60);
  });
});

describe("serializeCase paletteType fold", () => {
  const baseCase = (paletteType: string | null): HarnessCase => ({
    id: "p1",
    runner: "color-palettes-server",
    utterance: "neon",
    turn: 0,
    expected: { colorPalette: [] },
    paletteType,
  });

  test("folds paletteType into actual when a colorPalette answer is present", () => {
    const row = serializeCase(baseCase("regular"), {
      actual: { colorPalette: ["#0ff", "#f0f"] },
    });
    expect((row.actual as Record<string, unknown>).paletteType).toBe("regular");
    expect((row.actual as Record<string, unknown>).colorPalette).toEqual(["#0ff", "#f0f"]);
  });

  test("does not add paletteType when there is no colorPalette answer", () => {
    const row = serializeCase(baseCase("regular"), {
      actual: { notionalSpec: { chart: "bar" } },
    });
    expect((row.actual as Record<string, unknown>).paletteType).toBeUndefined();
  });

  test("does not add paletteType when the case has none", () => {
    const row = serializeCase(baseCase(null), { actual: { colorPalette: ["#0ff"] } });
    expect((row.actual as Record<string, unknown>).paletteType).toBeUndefined();
  });
});


test("a serialized row keeps the server's field scope", () => {
  // A row records which fields the server matched and scoped the question to,
  // so a 'no such field' answer can be traced to the server's search.
  const c = { id: "tc-1", runner: "ect-server", datasource: "ds", utterance: "profit by region" };
  const result = {
    actual: { intent: "NLQ_TO_NOTIONAL_SPEC", notionalSpec: null, user_friendly_reply: "I don't see a field named Profit." },
    latency: 1.5,
    evaluatorData: {
      scoped_datasource_fields: [{ caption: "Sales", dataType: "number" }],
      semanticsearch_results: [{ fieldName: "Sales" }, { fieldName: "Region" }],
      datasource_fields: [{ caption: "Sales" }, { caption: "Region" }, { caption: "Profit" }],
    },
  };
  const row = serializeCase(c, result);
  expect(row.debug_info?.server_field_scope).toEqual({
    scoped_fields: ["Sales"],
    search_matches: ["Sales", "Region"],
    datasource_field_count: 3,
  });
  expect(String(row.actual?.user_friendly_reply)).toStartWith("I don't see");
  expect(serializeCase(c, { ...result, evaluatorData: {} }).debug_info).not.toHaveProperty("server_field_scope");
});
