/**
 * Orchestrator tests — drive a run end-to-end with an INJECTED fake adapter
 * over synthetic cases into a temp/in-memory SQLite, asserting run rows,
 * metric rows, the event stream, and pause/cancel behavior. No live calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_SUMMARY_ERROR, PaletteAdapter } from "@tableau-ai-eval/evals";
import { AiEvalDb, RunLifecycle } from "@tableau-ai-eval/core";
import { SseState } from "@tableau-ai-eval/core";
import { TableauAuthError } from "@tableau-ai-eval/core";
import type {
  EmitCase,
  EvalAdapter,
  RowPayload,
  RunConfig,
  ShouldStop,
  SuitePlan,
} from "@tableau-ai-eval/core";
import {
  runNlqEval,
  runNlqEvalJob,
  formulaOf,
  friendlyFailure,
  maybeStartCesBridge,
  hasAnswer,
  isFailedCase,
  isTransientFailure,
  NO_FORMULA_EXPLANATION,
  plainExplanation,
  type OrchestratorDeps,
} from "./orchestrator.ts";
import { DEFAULT_RETRY_DELAY_MS } from "../bridge/ces.ts";

// ---------------------------------------------------------------------------
// Fake adapter driving N synthetic cases
// ---------------------------------------------------------------------------

interface FakeCase {
  id: string;
  utterance: string;
  metrics?: Record<string, Array<{ metric_id: string; metric_name: string; score: number | null; explanation: string | null }>>;
  actual?: Record<string, unknown>;
  errors?: RowPayload["errors"];
}

function makeFakeAdapter(cases: FakeCase[][]): {
  adapter: EvalAdapter;
  closed: () => boolean;
} {
  let sessionClosed = false;
  const flat = cases.flat();
  const adapter: EvalAdapter = {
    id: "fake",
    session() {
      return {
        close() {
          sessionClosed = true;
        },
      };
    },
    load(): SuitePlan {
      return {
        total: flat.length,
        skeletons: flat.map((c) => ({
          test_case_id: c.id,
          runner: "fake",
          datasource: null,
          utterance: c.utterance,
          expected: {},
        })),
        conversation_ids: cases.map((conv) => conv.map((c) => c.id)),
      };
    },
    async execute(
      _plan: SuitePlan,
      _config: RunConfig,
      emitCase: EmitCase,
      shouldStop: ShouldStop,
      completedIds: Set<string>,
    ): Promise<void> {
      for (const conv of cases) {
        if (shouldStop()) return;
        if (conv.length && conv.every((c) => completedIds.has(c.id))) continue;
        for (const c of conv) {
          if (shouldStop()) return;
          const row: RowPayload = {
            test_case_id: c.id,
            runner: "fake",
            datasource: null,
            utterance: c.utterance,
            turn: 0,
            expected: {},
            actual: c.actual ?? {},
            latency: 0.1,
            errors: c.errors ?? [],
            metrics: c.metrics ?? {},
            debug_info: {},
            info: {},
          };
          await emitCase(row);
          if (shouldStop()) return;
        }
      }
    },
  };
  return { adapter, closed: () => sessionClosed };
}

// ---------------------------------------------------------------------------

let db: AiEvalDb;
let sse: SseState;

function baseDeps(adapter: EvalAdapter, extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    db,
    sse,
    getAdapter: async () => adapter,
    ...extra,
  };
}

function eventTypes(jobId: string): string[] {
  return sse.getEvents(jobId).map((e) => JSON.parse(e.payload).type);
}

beforeEach(() => {
  db = new AiEvalDb(":memory:");
  db.initDb();
  sse = new SseState(db);
});

afterEach(() => {
  db.close();
});

describe("runNlqEvalJob (orchestrator)", () => {
  it("reports preparation as started and never resurrects a run cancelled while loading", async () => {
    const { adapter, closed } = makeFakeAdapter([[{ id: "c1", utterance: "hi" }]]);
    const load = adapter.load.bind(adapter);
    let release!: () => void;
    let loading!: () => void;
    const entered = new Promise<void>(resolve => { loading = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    adapter.load = async config => { loading(); await gate; return load(config); };
    const pending = runNlqEvalJob(baseDeps(adapter), {}, "preparing");
    await entered;
    expect(db.getJobState("preparing").status).toBe("started");
    expect(db.getJobState("preparing").phase).toBe("Loading the test cases");
    new RunLifecycle(db, sse).stop("preparing", "cancelled");
    release();
    await pending;
    expect(db.getRun("preparing")?.status).toBe("cancelled");
    expect(db.getResults("preparing")).toHaveLength(0);
    expect(closed()).toBe(true);
  });

  it("aborts preparation network calls and does not recreate a deleted cancelled job", async () => {
    const { adapter } = makeFakeAdapter([[{ id: "c1", utterance: "hi" }]]);
    const controllers = new Map<string, AbortController>();
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    const pending = runNlqEvalJob(baseDeps(adapter, {
      runControllers: controllers,
      cesFetch: (async (_url, init) => {
        signal = init?.signal as AbortSignal;
        entered();
        return await new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      }) as typeof fetch,
    }), { tableau_server: "https://tableau.example", pat_name: "p", pat_value: "secret", identity_pending: true }, "abort-prep");
    await waiting;
    db.setJobControl("abort-prep", "cancel");
    controllers.get("abort-prep")!.abort();
    db.deleteRun("abort-prep");
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(db.getRun("abort-prep")).toBeNull();
    expect(db.getJobState("abort-prep")).toEqual({});
    expect(sse.getEvents("abort-prep")).toHaveLength(0);
    expect(controllers.size).toBe(0);
  });

  it("never starts a job cancelled while waiting in the queue", async () => {
    const { adapter } = makeFakeAdapter([[{ id: "c1", utterance: "hi" }]]);
    db.setJobControl("queued-cancel", "cancel");
    db.patchJobState("queued-cancel", { status: "cancelled" });
    await runNlqEvalJob(baseDeps(adapter), {}, "queued-cancel");
    expect(db.getRun("queued-cancel")).toBeNull();
    expect(db.getJobState("queued-cancel").status).toBe("cancelled");
  });

  it("discards late case callbacks after cancellation and deletion", async () => {
    const { adapter } = makeFakeAdapter([[{ id: "c1", utterance: "hi" }]]);
    const controllers = new Map<string, AbortController>();
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (plan, config, emit, stop, completed) => {
      controllers.get("late-case")!.abort();
      db.deleteRun("late-case");
      plan.case_started?.("c1");
      await execute(plan, config, emit, stop, completed);
    };
    await runNlqEvalJob(baseDeps(adapter, { runControllers: controllers }), {}, "late-case");
    expect(db.getRun("late-case")).toBeNull();
    expect(db.getJobState("late-case")).toEqual({});
    expect(sse.getEvents("late-case")).toHaveLength(0);
  });

  it("drives synthetic cases end-to-end: run rows, metric rows, event stream", async () => {
    const { adapter, closed } = makeFakeAdapter([
      [
        {
          id: "c1",
          utterance: "hi",
          metrics: {
            vizQuality: [
              { metric_id: "VizQuality", metric_name: "chartSimilarity", score: 1, explanation: null },
            ],
          },
        },
      ],
      [
        { id: "c2", utterance: "hey" },
        { id: "c3", utterance: "yo" },
      ],
    ]);

    const callerConfig: Record<string, unknown> = { adapter: "fake" };
    await runNlqEvalJob(baseDeps(adapter), callerConfig, "job1");
    // The job works on a private copy: nothing it sets
    // (bridge gateway_url/llm_key, job_id) leaks into the caller's config,
    // which is cached for resume.
    expect(callerConfig).toEqual({ adapter: "fake" });

    // run row finished
    const run = db.getRun("job1")!;
    expect(run.status).toBe("finished");
    expect(run.total).toBe(3);
    expect(run.completed).toBe(3);

    // result rows for all 3 cases
    const results = db.getResults("job1");
    expect(results.map((r) => r.test_case_id).sort()).toEqual(["c1", "c2", "c3"]);

    // metric row for c1
    const metrics = db.getMetrics("job1");
    expect(metrics.length).toBe(1);
    expect(metrics[0].metric_name).toBe("chartSimilarity");

    // event stream: start, skeletons, then per-case row/progress, then done
    const types = eventTypes("job1");
    expect(types[0]).toBe("start");
    expect(types[1]).toBe("skeletons");
    expect(types.filter((t) => t === "row").length).toBe(3);
    expect(types.filter((t) => t === "progress").length).toBe(3);
    expect(types[types.length - 1]).toBe("done");

    const done = JSON.parse(sse.getEvents("job1").at(-1)!.payload);
    expect(done.status).toBe("finished");

    // adapter session was torn down
    expect(closed()).toBe(true);

    // job_state reflects finished
    expect(db.getJobState("job1").status).toBe("finished");
  });

  it("cancel at a case boundary stops early and marks cancelled", async () => {
    const cases: FakeCase[][] = [
      [{ id: "a", utterance: "1" }],
      [{ id: "b", utterance: "2" }],
      [{ id: "c", utterance: "3" }],
    ];
    // Adapter that sets the cancel control after the first case emits.
    const { adapter } = makeFakeAdapter(cases);
    const deps = baseDeps(adapter);

    // Wrap execute to request cancel after first emit.
    const origExecute = adapter.execute.bind(adapter);
    adapter.execute = async (plan, config, emitCase, shouldStop, completedIds) => {
      let n = 0;
      const wrapped: EmitCase = async (row) => {
        await emitCase(row);
        n += 1;
        if (n === 1) db.setJobControl("job2", "cancel");
      };
      await origExecute(plan, config, wrapped, shouldStop, completedIds);
    };

    await runNlqEvalJob(deps, { adapter: "fake" }, "job2");

    const run = db.getRun("job2")!;
    expect(run.status).toBe("cancelled");
    // Only the first case ran before cancel took effect at the boundary.
    expect(db.getResults("job2").length).toBe(1);
    const types = eventTypes("job2");
    expect(types[types.length - 1]).toBe("done");
    expect(JSON.parse(sse.getEvents("job2").at(-1)!.payload).status).toBe("cancelled");
  });

  it("pause at a case boundary preserves results and marks paused", async () => {
    const cases: FakeCase[][] = [
      [{ id: "a", utterance: "1" }],
      [{ id: "b", utterance: "2" }],
    ];
    const { adapter } = makeFakeAdapter(cases);
    const deps = baseDeps(adapter);
    const origExecute = adapter.execute.bind(adapter);
    adapter.execute = async (plan, config, emitCase, shouldStop, completedIds) => {
      let n = 0;
      const wrapped: EmitCase = async (row) => {
        await emitCase(row);
        n += 1;
        if (n === 1) db.setJobControl("job3", "pause");
      };
      await origExecute(plan, config, wrapped, shouldStop, completedIds);
    };

    await runNlqEvalJob(deps, { adapter: "fake" }, "job3");

    const run = db.getRun("job3")!;
    expect(run.status).toBe("paused");
    expect(db.getResults("job3").length).toBe(1);
    expect(run.completed).toBe(1);
    expect(JSON.parse(sse.getEvents("job3").at(-1)!.payload).status).toBe("paused");
  });

  it("cancel landing DURING emit is not resurrected to started (TOCTOU)", async () => {
    // Regression for T1.2: a /cancel (or /pause) landing between emitCase's
    // control check and its status write must NOT be overwritten back to
    // "started", and no extra "progress" event may fire after the terminal
    // transition. Here the control flag is set to "cancel" *during* the emit
    // of the first case (before the inner emitCase runs its status write).
    const cases: FakeCase[][] = [
      [{ id: "a", utterance: "1" }],
      [{ id: "b", utterance: "2" }],
    ];
    const { adapter } = makeFakeAdapter(cases);
    const deps = baseDeps(adapter);
    const origExecute = adapter.execute.bind(adapter);
    adapter.execute = async (plan, config, emitCase, shouldStop, completedIds) => {
      const wrapped: EmitCase = async (row) => {
        // Cancel lands mid-emit, before emitCase performs its status write.
        db.setJobControl("jobT", "cancel");
        // Simulate the endpoint having already transitioned the run row.
        db.updateRunStatus("jobT", "cancelled");
        await emitCase(row);
      };
      await origExecute(plan, config, wrapped, shouldStop, completedIds);
    };

    await runNlqEvalJob(deps, { adapter: "fake" }, "jobT");

    // (a) final run status stays terminal — not resurrected to started/running.
    const run = db.getRun("jobT")!;
    expect(run.status).toBe("cancelled");

    // (b) no "progress" event was emitted (the status write inside emitCase
    // was suppressed by the terminal/control guard).
    const types = eventTypes("jobT");
    expect(types.filter((t) => t === "progress").length).toBe(0);

    // Terminal "done" event reports cancelled and is last.
    expect(types[types.length - 1]).toBe("done");
    expect(JSON.parse(sse.getEvents("jobT").at(-1)!.payload).status).toBe("cancelled");
  });

  it("terminal run status is never downgraded to started by a progress write", async () => {
    // Regression for T1.2 (the pure downgrade path): even if the control flag
    // is momentarily clear, emitCase must not rewrite a run that is already in
    // a terminal state back to "started". Simulate the endpoint having already
    // marked the run "cancelled" (and cleared control) right before the write.
    const cases: FakeCase[][] = [[{ id: "a", utterance: "1" }]];
    const { adapter } = makeFakeAdapter(cases);
    const deps = baseDeps(adapter);
    const origExecute = adapter.execute.bind(adapter);
    adapter.execute = async (plan, config, emitCase, shouldStop, completedIds) => {
      const wrapped: EmitCase = async (row) => {
        // Endpoint already transitioned to terminal; control not (yet) set.
        new RunLifecycle(db, sse).stop("jobT2", "cancelled");
        await emitCase(row);
      };
      await origExecute(plan, config, wrapped, shouldStop, completedIds);
    };

    await runNlqEvalJob(deps, { adapter: "fake" }, "jobT2");

    // Run must NOT have been resurrected to started/running by the progress write.
    expect(db.getRun("jobT2")!.status).not.toBe("started");
    // No progress event fired (terminal guard suppressed the write).
    expect(eventTypes("jobT2").filter((t) => t === "progress").length).toBe(0);
  });

  it("resume skips completed conversations (skip-list)", async () => {
    const cases: FakeCase[][] = [
      [{ id: "a", utterance: "1" }],
      [{ id: "b", utterance: "2" }],
    ];
    // Seed 'a' as already-completed.
    db.createRun({
      job_id: "job4",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.insertTestResult({
      job_id: "job4",
      test_case_id: "a",
      runner: "fake",
      datasource: null,
      utterance: "1",
      expected: {},
      actual: {},
      latency: null,
    });

    const { adapter } = makeFakeAdapter(cases);
    const executed: string[] = [];
    const origExecute = adapter.execute.bind(adapter);
    adapter.execute = async (plan, config, emitCase, shouldStop, completedIds) => {
      const wrapped: EmitCase = async (row) => {
        executed.push(row.test_case_id);
        await emitCase(row);
      };
      await origExecute(plan, config, wrapped, shouldStop, completedIds);
    };

    await runNlqEval(baseDeps(adapter), "job4", {});

    // 'a' was skipped; only 'b' ran.
    expect(executed).toEqual(["b"]);
    const run = db.getRun("job4")!;
    expect(run.status).toBe("finished");
    // Skeletons NOT re-emitted since a prior... (fresh here, but resume path
    // relies on getEvents skeletons check). Assert start emitted with total.
    const start = JSON.parse(sse.getEvents("job4")[0].payload);
    expect(start.type).toBe("start");
    expect(start.total).toBe(2);
  });

  it("attaches judge metrics via injected fetch when compute_nl_judge is set", async () => {
    db.setSetting("judge", { provider: "openai", model: "gpt-4o", api_key: "sk-test" });
    const cases: FakeCase[][] = [
      [{ id: "a", utterance: "make a bar chart", actual: { userFriendlyReply: "here it is" } }],
    ];
    const { adapter } = makeFakeAdapter(cases);

    // Fake OpenAI response returning judge JSON.
    const judgeFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  coherence: { score: 0.9, reason: "good" },
                  insightfulness: { score: 0.8, reason: "ok" },
                  factualGrounding: { score: 0.7, reason: "fine" },
                  followUpRelevance: { score: 0.6, reason: "meh" },
                }),
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await runNlqEvalJob(
      baseDeps(adapter, { judgeFetch }),
      { adapter: "fake", compute_nl_judge: true },
      "job5",
    );

    const metrics = db.getMetrics("job5");
    const judge = metrics.filter((m) => m.stage === "llmJudge");
    expect(judge.length).toBeGreaterThan(0);
  });

  it("routes a palette case (no reply) to the palette judge, into the judge stage", async () => {
    db.setSetting("judge", { provider: "openai", model: "gpt-4o", api_key: "sk-test" });
    const cases: FakeCase[][] = [
      [
        {
          id: "pal",
          utterance: "neon video game",
          // No userFriendlyReply — a palette answer has no prose. The palette
          // rubric is scored by the configured judge instead of the NL judge.
          actual: { colorPalette: ["#0ff", "#f0f"], paletteType: "regular" },
        },
      ],
    ];
    const { adapter } = makeFakeAdapter(cases);

    const judgeFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  valid: true,
                  relevance: 0.8,
                  design: 0.65,
                  validReasoning: "all hex",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await runNlqEvalJob(
      baseDeps(adapter, { judgeFetch }),
      { adapter: "fake", compute_nl_judge: true },
      "jobPal",
    );

    const metrics = db.getMetrics("jobPal");
    const judge = metrics.filter((m) => m.stage === "llmJudge");
    const names = judge.map((m) => m.metric_name).sort();
    expect(names).toEqual(["design", "relevance", "valid"]);
    // NL-judge dimensions must NOT appear (the NL judge never ran).
    expect(names).not.toContain("coherence");
  });

  it("an unwired/failing adapter fails the run cleanly", async () => {
    const badAdapter: EvalAdapter = {
      id: "bad",
      session() {
        return { close() {} };
      },
      load() {
        throw new Error("harness not wired");
      },
      async execute() {},
    };
    await runNlqEvalJob(baseDeps(badAdapter), { adapter: "bad" }, "job6");
    const run = db.getRun("job6")!;
    expect(run.status).toBe("failed");
    expect(String(run.error)).toContain("harness not wired");
    const types = eventTypes("job6");
    expect(types).toContain("error");
    expect(types[types.length - 1]).toBe("done");
  });

  it("redacts secrets in the stored run config", async () => {
    const { adapter } = makeFakeAdapter([[{ id: "a", utterance: "1" }]]);
    await runNlqEvalJob(
      baseDeps(adapter),
      { adapter: "fake", llm_key: "supersecretvalue", org_id: "o" },
      "job7",
    );
    const run = db.getRun("job7")!;
    const cfg = run.config as Record<string, unknown>;
    expect(String(cfg.llm_key)).toStartWith("****");
    expect(cfg.llm_key).not.toBe("supersecretvalue");
  });
});

describe("maybeStartCesBridge backoff (T1.4)", () => {
  const cesConfig = {
    generations_mode: "ces",
    ces_url: "https://ces.example.com",
  };

  it("uses a non-zero exponential backoff in production (default)", () => {
    const bridge = maybeStartCesBridge(baseDeps({} as never), { ...cesConfig }, "jobCes")!;
    try {
      expect(bridge).not.toBeNull();
      // Orchestrator injects the production backoff base; tests inject 0.
      expect(bridge.retryDelayMs).toBe(DEFAULT_RETRY_DELAY_MS);
      expect(bridge.retryDelayMs).toBeGreaterThan(0);
    } finally {
      bridge.stop();
    }
  });

  it("lets tests inject a zero backoff for instant retries", () => {
    const bridge = maybeStartCesBridge(
      baseDeps({} as never, { cesRetryDelayMs: 0 }),
      { ...cesConfig },
      "jobCes0",
    )!;
    try {
      expect(bridge.retryDelayMs).toBe(0);
    } finally {
      bridge.stop();
    }
  });
});

describe("dead-PAT auto-pause (T4.3 / orchestrator ~L291-297)", () => {
  it("onAuthFailure sets job control=pause and records pause_reason", async () => {
    // A CES-mode run wires a TableauSession with an onAuthFailure callback:
    // when the PAT is dead, the session's signin returns 401, fires
    // onAuthFailure(reason) -> db.setJobControl(jobId,"pause") + writeState
    // pause_reason, then throws TableauAuthError. We drive that through the
    // real bridge (built by maybeStartCesBridge) by injecting a cesFetch that
    // refuses signin with a 401, then forwarding one prompt.
    const jobId = "jobDeadPat";
    db.createRun({ job_id: jobId, org_id: "", user_id: "", ai_feature: "", runner_name: "", config: {} });
    const cesFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/signin")) return new Response("nope", { status: 401 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const config = {
      generations_mode: "ces",
      ces_url: "https://ces.example.com",
      tableau_server: "https://tab.example.com",
      pat_name: "p",
      pat_value: "dead-pat",
      tableau_site: "",
    };

    const bridge = maybeStartCesBridge(
      baseDeps({} as never, { cesFetch, cesRetryDelayMs: 0 }),
      config,
      jobId,
    )!;
    try {
      // Forwarding triggers authHeaders() -> getToken() -> signin 401 ->
      // onAuthFailure fires -> then TableauAuthError propagates.
      await expect(bridge.forward("hello", "m", 0)).rejects.toBeInstanceOf(
        TableauAuthError,
      );
    } finally {
      bridge.stop();
    }

    // (a) job control auto-paused.
    expect(db.getJobControl(jobId)).toBe("pause");
    // (b) job state carries a pause_reason describing the dead PAT.
    const st = db.getJobState(jobId);
    expect(typeof st.pause_reason).toBe("string");
    expect(String(st.pause_reason)).toContain("isn't valid or has expired");
  });
});

// ---------------------------------------------------------------------------
// Retry pass for gateway / network failures
// ---------------------------------------------------------------------------

/**
 * Fails the given cases on the FIRST execute() only, the way a site gateway
 * that answers 5xx for a few seconds does.
 */
function makeFlakyAdapter(
  cases: FakeCase[][],
  failFirst: Set<string>,
  description = "Bad response (500): None",
): { adapter: EvalAdapter; calls: () => number } {
  const flat = cases.flat();
  let executeCalls = 0;
  const adapter: EvalAdapter = {
    id: "flaky",
    session() {
      return { close() {} };
    },
    load(): SuitePlan {
      return {
        total: flat.length,
        skeletons: flat.map((c) => ({
          test_case_id: c.id,
          runner: "flaky",
          datasource: null,
          utterance: c.utterance,
          expected: {},
        })),
        conversation_ids: cases.map((conv) => conv.map((c) => c.id)),
      };
    },
    async execute(_plan, _config, emitCase, shouldStop, completedIds) {
      executeCalls += 1;
      const first = executeCalls === 1;
      for (const conv of cases) {
        for (const c of conv) {
          if (completedIds.has(c.id)) continue;
          if (shouldStop()) return;
          if (first && failFirst.has(c.id)) {
            await emitCase({
              test_case_id: c.id,
              runner: "flaky",
              datasource: null,
              utterance: c.utterance,
              turn: 0,
              expected: {},
              actual: {}, // no result
              latency: null,
              errors: [{ phase: "RUN_TEST", description, warning: false }],
              metrics: {},
              debug_info: {},
              info: {},
            });
          } else {
            await emitCase({
              test_case_id: c.id,
              runner: "flaky",
              datasource: null,
              utterance: c.utterance,
              turn: 0,
              expected: {},
              actual: { userFriendlyReply: "ok" },
              latency: 0.1,
              errors: [],
              metrics: {},
              debug_info: {},
              info: {},
            });
          }
        }
      }
    },
  };
  return { adapter, calls: () => executeCalls };
}

describe("retry pass for gateway/network failures", () => {
  const cfg: RunConfig = { adapter: "flaky" };

  it("retries a transient gateway failure once after the suite", async () => {
    const { adapter, calls } = makeFlakyAdapter(
      [[{ id: "tc-1", utterance: "a" }], [{ id: "tc-2", utterance: "b" }], [{ id: "tc-3", utterance: "c" }]],
      new Set(["tc-2"]),
    );
    await runNlqEvalJob(baseDeps(adapter), cfg, "jobR1");

    expect(calls()).toBe(2);
    const run = db.getRun("jobR1")!;
    expect(run.status).toBe("finished");
    expect(run.completed).toBe(3);

    const rows = db.getResults("jobR1");
    // no duplicate row for the retried case
    expect(rows.map((r) => r.test_case_id).sort()).toEqual(["tc-1", "tc-2", "tc-3"]);
    // the retry answered -> tc-2 has no lingering error
    expect(db.getErrors("jobR1").filter((e) => e.test_case_id === "tc-2").length).toBe(0);

    const types = eventTypes("jobR1");
    expect(types.filter((t) => t === "row").length).toBe(4); // 3 + retried one
    expect(types[types.length - 1]).toBe("done");
    expect(types).not.toContain("error"); // stream treats "error" as terminal
    const progress = sse
      .getEvents("jobR1")
      .filter((e) => JSON.parse(e.payload).type === "progress")
      .map((e) => JSON.parse(e.payload).completed as number);
    expect(progress[progress.length - 1]).toBe(3);
    expect(Math.max(...progress)).toBe(3); // never overshoots
    // The page is told which cases are asked again, and that the count went
    // back: without it a finished suite silently returned to "2 of 3".
    const payloads = sse.getEvents("jobR1").map((e) => JSON.parse(e.payload));
    expect(payloads.filter((p) => p.type === "retrying")).toEqual([{ type: "retrying", ids: ["tc-2"] }]);
    const after = types.indexOf("retrying");
    expect(types[after + 1]).toBe("progress");
    expect(payloads[after + 1].completed).toBe(2);
    expect(types.slice(after + 1).filter((t) => t === "row").length).toBe(1);
    // cleared once the second attempt is over
    expect(db.getJobState("jobR1").retrying_case_ids).toEqual([]);
  });

  it("skips the retry pass when more than half the suite fails", async () => {
    const { adapter, calls } = makeFlakyAdapter(
      [[{ id: "tc-1", utterance: "a" }], [{ id: "tc-2", utterance: "b" }], [{ id: "tc-3", utterance: "c" }]],
      new Set(["tc-1", "tc-2", "tc-3"]),
    );
    await runNlqEvalJob(baseDeps(adapter), cfg, "jobR2");

    expect(calls()).toBe(1); // gateway is down: don't double the run
    expect(db.getRun("jobR2")!.status).toBe("finished");
    expect(db.getResults("jobR2").length).toBe(3);
    expect(db.getErrors("jobR2").length).toBe(3);
    expect(eventTypes("jobR2")).not.toContain("error");
  });

  for (const transient of [true, false]) {
    it(`${transient ? "retries" : "counts but does not retry"} a Dashboard Q&A server error with an apology`, async () => {
      const description = transient
        ? 'REACT_UTTERANCE_CLASSIFICATION_ERROR: I/O error on POST request for "http://proxy/chat/completions": proxy'
        : "QUERY_TRANSLATION_ERROR: Query translation failed";
      const { adapter, calls } = makeFlakyAdapter(
        [[{ id: "tc-1", utterance: "a" }], [{ id: "tc-2", utterance: "b" }]],
        new Set(["tc-1"]),
        description,
      );
      const execute = adapter.execute.bind(adapter);
      adapter.execute = (plan, config, emitCase, shouldStop, completedIds) =>
        execute(plan, config, async (row) => {
          row.runner = "cabu-dashboard-qa";
          if (row.errors.length) {
            row.errors[0].phase = "cabu";
            row.actual = { user_friendly_reply: "Sorry, a technical error prevented an answer." };
            row.debug_info.server_error = { error_details: description };
          }
          await emitCase(row);
        }, shouldStop, completedIds);
      const jobId = `jobCabuError-${transient}`;
      await runNlqEvalJob(baseDeps(adapter), cfg, jobId);
      expect(calls()).toBe(transient ? 2 : 1);
      expect(db.getResults(jobId)).toHaveLength(2);
      expect(db.getErrors(jobId)).toHaveLength(transient ? 0 : 1);
      expect(db.getJobState(jobId).failed_cases).toBe(transient ? 0 : 1);
      expect(eventTypes(jobId).includes("retrying")).toBe(transient);
      if (!transient) {
        const row = db.getResults(jobId).find((r) => r.test_case_id === "tc-1")!;
        expect((row.actual as Record<string, unknown>).user_friendly_reply).toContain("Sorry");
      }
    });
  }

  it("does not retry non-gateway errors", async () => {
    const { adapter, calls } = makeFlakyAdapter(
      [[{ id: "tc-1", utterance: "a" }], [{ id: "tc-2", utterance: "b" }]],
      new Set(["tc-1"]),
      "Could not register datasource 'x' with the analytics-assistant service (403): None",
    );
    await runNlqEvalJob(baseDeps(adapter), cfg, "jobR3");

    expect(calls()).toBe(1);
    expect(db.getErrors("jobR3").length).toBe(1);
  });

  it("a resume retries gateway failures from before the interruption", async () => {
    // A run interrupted before its retry pass (the tool restarted mid-run,
    // 2026-10-12) keeps its gateway-failed rows as errors unless the resume
    // gives them the retry the pass would have.
    const { adapter, calls } = makeFlakyAdapter(
      [[{ id: "tc-1", utterance: "a" }], [{ id: "tc-2", utterance: "b" }], [{ id: "tc-3", utterance: "c" }]],
      new Set(["tc-2"]),
    );
    const origExecute = adapter.execute.bind(adapter);
    let pauseAfterTc2 = true;
    adapter.execute = async (plan, config, emitCase, shouldStop, completedIds) => {
      const wrapped: EmitCase = async (row) => {
        await emitCase(row);
        if (pauseAfterTc2 && row.test_case_id === "tc-2") db.setJobControl("jobR4", "pause");
      };
      await origExecute(plan, config, wrapped, shouldStop, completedIds);
    };
    await runNlqEvalJob(baseDeps(adapter), cfg, "jobR4");
    expect(db.getRun("jobR4")!.status).toBe("paused");
    expect(calls()).toBe(1); // paused before the retry pass
    expect(db.getErrors("jobR4").map((e) => e.test_case_id)).toEqual(["tc-2"]);
    expect(new Set(db.getResults("jobR4").map((r) => r.test_case_id))).toEqual(new Set(["tc-1", "tc-2"]));

    pauseAfterTc2 = false;
    new RunLifecycle(db, sse).resume("jobR4");
    await runNlqEvalJob(baseDeps(adapter), cfg, "jobR4");

    const run = db.getRun("jobR4")!;
    expect(run.status).toBe("finished");
    expect(run.completed).toBe(3);
    expect(db.getResults("jobR4").map((r) => r.test_case_id).sort()).toEqual(["tc-1", "tc-2", "tc-3"]); // no duplicate row
    expect(db.getErrors("jobR4")).toEqual([]); // tc-2 answered on the resume
    expect(calls()).toBe(2); // tc-1 and tc-3 were not re-run
  });
});

// ---------------------------------------------------------------------------
// 401-streak auto-pause, error annotation, failed_cases/dominant_error
// ---------------------------------------------------------------------------

/**
 * Emits one error-only case per id (no result), with a per-id error
 * description, on every execute(). Honors completedIds so a resume skips
 * already-done cases. One case per conversation.
 */
function makeErroringAdapter(
  descById: Record<string, string>,
): { adapter: EvalAdapter; calls: () => number } {
  const ids = Object.keys(descById);
  let executeCalls = 0;
  const adapter: EvalAdapter = {
    id: "erroring",
    session() {
      return { close() {} };
    },
    load(): SuitePlan {
      return {
        total: ids.length,
        skeletons: ids.map((id) => ({
          test_case_id: id,
          runner: "erroring",
          datasource: null,
          utterance: id,
          expected: {},
        })),
        conversation_ids: ids.map((id) => [id]),
      };
    },
    async execute(_plan, _config, emitCase, shouldStop, completedIds) {
      executeCalls += 1;
      for (const id of ids) {
        if (completedIds.has(id)) continue;
        if (shouldStop()) return;
        await emitCase({
          test_case_id: id,
          runner: "erroring",
          datasource: null,
          utterance: id,
          turn: 0,
          expected: {},
          actual: {},
          latency: null,
          errors: [{ phase: "RUN_TEST", description: descById[id], warning: false }],
          metrics: {},
          debug_info: {},
          info: {},
        });
        if (shouldStop()) return;
      }
    },
  };
  return { adapter, calls: () => executeCalls };
}

describe("401-streak auto-pause + error annotation + failed_cases", () => {
  const cfg: RunConfig = { adapter: "erroring" };

  it("pauses and releases the cases after 3 consecutive 401 failures", async () => {
    const { adapter } = makeErroringAdapter({
      "tc-1": "Bad response (401): unauthorized",
      "tc-2": "Bad response (401): unauthorized",
      "tc-3": "Bad response (401): unauthorized",
    });
    await runNlqEvalJob(baseDeps(adapter), cfg, "jobAuth");

    // Control flag set to pause; done event says paused.
    expect(db.getJobControl("jobAuth")).toBe("pause");
    const done = JSON.parse(sse.getEvents("jobAuth").at(-1)!.payload);
    expect(done.status).toBe("paused");
    // The streak's cases were released (deleted) so a resume re-runs them.
    expect(db.getResults("jobAuth").length).toBe(0);
    // pause_reason names the lost-session cause.
    const st = db.getJobState("jobAuth");
    expect(String(st.pause_reason)).toContain("401 Unauthorized");
  });

  it("annotates 401/403 errors with a human hint and records failed_cases + dominant_error", async () => {
    const { adapter } = makeErroringAdapter({
      "tc-1": "Bad response (403): forbidden",
      "tc-2": "Bad response (500): gateway boom",
    });
    await runNlqEvalJob(baseDeps(adapter), cfg, "jobAnno");

    const run = db.getRun("jobAnno")!;
    expect(run.status).toBe("finished");
    // 403 error row carries the per-feature-switch hint.
    const errs = db.getErrors("jobAnno");
    const e403 = errs.find((e) => String(e.description).includes("403"));
    expect(String(e403!.description)).toContain("AI Settings by Feature");
    // Finished state carries failed_cases + a dominant_error.
    const st = db.getJobState("jobAnno");
    expect(st.failed_cases).toBe(2);
    expect(String(st.dominant_error)).toMatch(/case/);
    // done event carries failed_cases.
    const done = JSON.parse(sse.getEvents("jobAnno").at(-1)!.payload);
    expect(done.failed_cases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// "No answer" is an empty dict, not null (
// `Count a case with an empty answer as a failure`). The adapters serialize a
// case that got nothing back as `actual: {}` (or a dict of all-empty values),
// never null; the retry pass, 401 breaker and failed-case count must all fire.
// ---------------------------------------------------------------------------

describe("hasAnswer / empty-answer classification", () => {
  const err: RowPayload["errors"] = [
    { phase: "RUN_TEST", description: "Bad response (502): None", warning: false } as never,
  ];

  it("treats an empty dict (and all-empty-value dicts) like null", () => {
    for (const empty of [null, {}, { formula: null }, { a: "", b: [], c: {} }]) {
      const s = { actual: empty } as unknown as RowPayload;
      expect(hasAnswer(s)).toBe(false);
      expect(isFailedCase({ actual: empty, errors: err } as unknown as RowPayload)).toBe(true);
      expect(isTransientFailure({ actual: empty, errors: err } as unknown as RowPayload)).toBe(true);
    }
  });

  it("treats any non-empty value (including 0 / false) as an answer", () => {
    for (const answer of [
      { formula: "SUM([Sales])" },
      { user_friendly_reply: "hi" },
      { x: 0 },
      { ok: false },
    ]) {
      expect(hasAnswer({ actual: answer } as unknown as RowPayload)).toBe(true);
      expect(isFailedCase({ actual: answer, errors: err } as unknown as RowPayload)).toBe(false);
    }
  });

  it("never counts a warning-only case as failed", () => {
    const warnOnly = {
      actual: {},
      errors: [{ phase: "x", description: "w", warning: true }],
    } as unknown as RowPayload;
    expect(isFailedCase(warnOnly)).toBe(false);
  });

  it("distinguishes CABU server failures from warnings, scoring errors, and apology text", () => {
    const row = {
      runner: "cabu-dashboard-qa",
      actual: { user_friendly_reply: "Sorry, I ran into a technical error." },
      errors: [{ phase: "cabu", description: "Query translation failed", warning: false }],
    } as unknown as RowPayload;
    expect(hasAnswer(row)).toBe(true); // preserve the reply, not a successful result
    expect(isFailedCase(row)).toBe(true);
    expect(isTransientFailure(row)).toBe(false);
    for (const errors of [
      [],
      [{ phase: "cabu", description: "network error", warning: true }],
      [{ phase: "EVALUATE_RESULT", description: "network error", warning: false }],
    ]) {
      const other = { ...row, errors } as RowPayload;
      expect(isFailedCase(other)).toBe(false);
      expect(isTransientFailure(other)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// start/progress events carry the run status (bug bash 2026-09-23: the home
// page said Queued while the results page said Running for the same run —
// every surface now reads status from the event that changes it).
// ---------------------------------------------------------------------------

describe("start/progress events carry the run status", () => {
  it("start says started and every progress says started; done says finished", async () => {
    const { adapter } = makeFakeAdapter([[{ id: "a", utterance: "1" }], [{ id: "b", utterance: "2" }]]);
    await runNlqEval(baseDeps(adapter), "jobStatus", {});
    const events = sse.getEvents("jobStatus").map((e) => JSON.parse(e.payload));
    const start = events.filter((e) => e.type === "start");
    const progress = events.filter((e) => e.type === "progress");
    expect(start.length).toBeGreaterThan(0);
    expect(start[0].status).toBe("started");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((e: { status?: string }) => e.status === "started")).toBe(true);
    expect(events.at(-1).status).toBe("finished");
  });
});

// ---------------------------------------------------------------------------
// Lost-session auto-pause: with several conversations in flight cases finish
// out of order, so "N 401s in a row" becomes "N among the last few" (a sliding
// window). After AUTH_STREAK_LIMIT (3) the run pauses, releases the affected
// cases so a resume re-runs them, and names the cause.
// ---------------------------------------------------------------------------

describe("lost-session auto-pause (401 window)", () => {
  const auth401: RowPayload["errors"] = [
    { phase: "RUN_TEST", description: "Bad response (401): Unauthorized", warning: false } as never,
  ];

  it("pauses and releases after three 401 cases, naming the cause", async () => {
    const cases: FakeCase[][] = [
      [{ id: "a", utterance: "1", errors: auth401 }],
      [{ id: "b", utterance: "2", errors: auth401 }],
      [{ id: "c", utterance: "3", errors: auth401 }],
      [{ id: "d", utterance: "4" }],
    ];
    const { adapter } = makeFakeAdapter(cases);
    const deps = baseDeps(adapter);
    await runNlqEvalJob(deps, { adapter: "fake" }, "jobAuth");

    const run = db.getRun("jobAuth")!;
    expect(run.status).toBe("paused");
    const st = db.getJobState("jobAuth");
    expect(String(st.pause_reason)).toContain("401 Unauthorized");
    expect(String(st.pause_reason)).toContain("in a row");
    // The three 401 cases were released (their rows deleted) so a resume
    // re-runs them; none of the failed rows remain persisted.
    const ids = db.getResults("jobAuth").map((r) => r.test_case_id);
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("c");
  });

  it("does not pause when the 401s are spaced out by successes", async () => {
    // Two 401s, then a success clears one out of the window before a third.
    const cases: FakeCase[][] = [
      [{ id: "a", utterance: "1", errors: auth401 }],
      [{ id: "b", utterance: "2", actual: { formula: "SUM([X])" } }],
      [{ id: "c", utterance: "3", errors: auth401 }],
      [{ id: "d", utterance: "4", actual: { formula: "SUM([Y])" } }],
    ];
    const { adapter } = makeFakeAdapter(cases);
    const deps = baseDeps(adapter);
    // Force strictly sequential so the window semantics are deterministic.
    const prev = process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
    process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = "1";
    try {
      await runNlqEvalJob(deps, { adapter: "fake" }, "jobAuth2");
    } finally {
      if (prev === undefined) delete process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY;
      else process.env.TABLEAU_AI_EVAL_MAX_CONCURRENCY = prev;
    }
    expect(db.getRun("jobAuth2")!.status).toBe("finished");
  });
});

// ---------------------------------------------------------------------------
// Resume while a pause is still landing; the cases in flight
// ---------------------------------------------------------------------------

function row(id: string, extra: Partial<RowPayload> = {}): RowPayload {
  return {
    test_case_id: id,
    runner: "fake",
    datasource: null,
    utterance: id,
    turn: 0,
    expected: {},
    actual: { formula: "SUM([X])" },
    latency: 0.1,
    errors: [],
    metrics: {},
    debug_info: {},
    info: {},
    ...extra,
  };
}

function scriptedAdapter(
  ids: string[],
  execute: (
    plan: SuitePlan,
    emitCase: EmitCase,
    shouldStop: ShouldStop,
    completedIds: Set<string>,
  ) => Promise<void>,
): EvalAdapter {
  return {
    id: "fake",
    session: () => ({ close() {} }),
    load: (): SuitePlan => ({
      total: ids.length,
      skeletons: ids.map((id) => ({
        test_case_id: id,
        runner: "fake",
        datasource: null,
        utterance: id,
        expected: {},
      })),
      conversation_ids: ids.map((id) => [id]),
    }),
    execute: (plan, _config, emitCase, shouldStop, completedIds) =>
      execute(plan, emitCase, shouldStop, completedIds),
  };
}

describe("resume while pausing / cases in flight", () => {
  it("a resume while the pause is landing does not close the run as finished", async () => {
    // calcs-public, 2026-10-01: paused, resumed before the pause had landed,
    // and the first pass marked the run finished at 137 of 166.
    const JOB = "jobRwp";
    let pausePending = true;
    const adapter = scriptedAdapter(["a", "b", "c"], async (_plan, emitCase, shouldStop, done) => {
      for (const id of ["a", "b", "c"]) {
        if (done.has(id)) continue;
        if (shouldStop()) {
          new RunLifecycle(db, sse).stop(JOB, "paused");
          new RunLifecycle(db, sse).resume(JOB);
          // A later check in the same pass must still say stop.
          expect(shouldStop()).toBeTruthy();
          return;
        }
        await emitCase(row(id));
        if (pausePending) {
          pausePending = false;
          db.setJobControl(JOB, "pause");
        }
      }
    });
    const deps = baseDeps(adapter);
    await runNlqEvalJob(deps, { adapter: "fake" }, JOB);

    expect(db.getRun(JOB)!.status).not.toBe("finished");
    expect(db.getEvents(JOB, 0, ["done"])).toEqual([]);
    expect(db.getResults(JOB).length).toBe(1);

    // The pass the resume queued runs what the first one skipped.
    await runNlqEvalJob(deps, { adapter: "fake" }, JOB);
    const run = db.getRun(JOB)!;
    expect(run.status).toBe("finished");
    expect(run.completed).toBe(3);
    expect(db.getResults(JOB).length).toBe(3);
    const dones = db.getEvents(JOB, 0, ["done"]).map((e) => JSON.parse(e.payload).status);
    expect(dones).toEqual(["finished"]);
  });

  it("a new pass drops the averages cached when the run last ended", async () => {
    const { adapter } = makeFakeAdapter([[{ id: "a", utterance: "1" }], [{ id: "b", utterance: "2" }]]);
    const deps = baseDeps(adapter);
    await runNlqEvalJob(deps, { adapter: "fake" }, "jobSv");
    db.runScores(["jobSv"]); // caches the averages
    expect(db.getJobState("jobSv").score_version).not.toBeNull();
    expect(db.getJobState("jobSv").score_version).toBeDefined();

    new RunLifecycle(db, sse).commit("jobSv", { run: { status: "queued" } });
    await runNlqEvalJob(deps, { adapter: "fake" }, "jobSv");
    expect(db.getJobState("jobSv").score_version ?? null).toBeNull();
  });

  it("announces the cases in flight and clears them", async () => {
    const JOB = "jobRun";
    const adapter = scriptedAdapter(["tc-1", "tc-2"], async (plan, emitCase) => {
      for (const id of ["tc-1", "tc-2"]) {
        plan.case_started?.(id);
        await emitCase(row(id));
      }
    });
    await runNlqEvalJob(baseDeps(adapter), { adapter: "fake" }, JOB);

    const running = db.getEvents(JOB, 0, ["running"]).map((e) => JSON.parse(e.payload).ids);
    expect(running).toEqual([["tc-1"], ["tc-2"]]);
    // Each start is announced before that case's row.
    const types = eventTypes(JOB);
    expect(types.indexOf("running")).toBeLessThan(types.indexOf("row"));
    expect(db.getJobState(JOB).running_case_ids).toEqual([]);
  });

  it("stores the formula checker's explanations in words", async () => {
    // An empty formula used to be explained by the parser's end-of-input
    // error and its whole token list (calcs-public, 2026-10-01).
    const tokens = "expecting {EOL, WSS, LINECOMMENT, '(', FIELDNAME, IF, CASE}";
    const m = (explanation: string) => ({
      calculatedFieldFormula: [
        { metric_id: "CalcValidity", metric_name: "calcValidity", score: 0, explanation },
      ],
    });
    const JOB = "jobExpl";
    const adapter = scriptedAdapter(["tc-1", "tc-2", "tc-3", "tc-4"], async (_p, emitCase) => {
      await emitCase(
        row("tc-1", {
          metrics: m(`Syntax Error: Syntax error at line 1, column 0: mismatched input '<EOF>' ${tokens}`),
        }),
      );
      await emitCase(
        row("tc-2", {
          metrics: m(`Syntax Error: Syntax error at line 1, column 23: mismatched input ')' ${tokens}`),
        }),
      );
      await emitCase(
        row("tc-3", { metrics: m("Type mismatch in CASE ELSE: expected number, found None") }),
      );
      // The port's hand-rolled parser words the expectation in prose.
      await emitCase(
        row("tc-4", {
          metrics: m(
            "Syntax Error: Syntax error at line 1, column 3: mismatched input 'THEN' expecting a value expression",
          ),
        }),
      );
    });
    await runNlqEvalJob(baseDeps(adapter), { adapter: "fake" }, JOB);

    const stored = Object.fromEntries(
      db.getMetrics(JOB).map((r) => [r.test_case_id, r.explanation]),
    );
    expect(stored["tc-1"]).toBe(NO_FORMULA_EXPLANATION);
    expect(stored["tc-2"]).toBe(
      "Syntax Error: Syntax error at line 1, column 23: mismatched input ')'",
    );
    expect(stored["tc-3"]).toBe("Type mismatch in CASE ELSE: expected number, found None");
    expect(stored["tc-4"]).toBe(
      "Syntax Error: Syntax error at line 1, column 3: mismatched input 'THEN'",
    );
    expect(plainExplanation("Empty formula")).toBe(NO_FORMULA_EXPLANATION);
    expect(plainExplanation(["Empty formula", "x"])).toEqual([NO_FORMULA_EXPLANATION, "x"]);
    // The port's own empty-formula wording is recognised too.
    expect(
      plainExplanation(
        "Syntax Error: Syntax error at line 1, column 0: mismatched input '<EOF>' expecting a value expression",
      ),
    ).toBe(NO_FORMULA_EXPLANATION);
  });
});

// ---------------------------------------------------------------------------
// Color palettes through the orchestrator with the REAL palette adapter
// (938f1fdf test_a_full_run_persists_rows_metrics_and_judge_scores). The
// server is a fake fetch; the judge is a fake fetch.
// ---------------------------------------------------------------------------

describe("palette adapter end-to-end", () => {
  function paletteSuite(): string {
    const dir = mkdtempSync(join(tmpdir(), "pal-orch-"));
    const write = (name: string, id: string, utterance: string, type: string, expected: string[] = []) =>
      writeFileSync(
        join(dir, name),
        JSON.stringify({
          runner: "color-palettes-server",
          id,
          inputs: [{ utterance, arguments: { palette_type: type }, expected: { colorPalette: expected } }],
        }),
      );
    write("a.json", "case-a", "American flag colors", "regular", ["#FF0000", "#FFFFFF", "#0000FF"]);
    write("b.json", "case-b", "Ocean colors", "sequential");
    write("c.json", "case-c", "Profit and loss", "diverging");
    return dir;
  }

  it("persists rows, deterministic metrics and judge scores", async () => {
    const dir = paletteSuite();
    try {
      const adapter = new PaletteAdapter({
        fetchImpl: async () =>
          new Response(JSON.stringify({ colors: ["#B22234", "#FFFFFF", "#3C3B6E"] }), { status: 200 }),
        sleep: async () => {},
        sessionFor: () => null,
      });
      db.setSetting("judge", { provider: "openai", model: "gpt-4.1", api_key: "sk-x" });
      const prompts: string[] = [];
      const judgeFetch = (async (_u: string, init: RequestInit) => {
        prompts.push(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    valid: true, relevance: 0.9, design: 0.8,
                    validReasoning: "ok", relevanceReasoning: "ok", designReasoning: "ok",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      await runNlqEvalJob(
        baseDeps(adapter, { judgeFetch }),
        {
          adapter: "palettes",
          ces_url: "http://localhost:8080",
          test_path: dir,
          runner: "color-palettes-server",
          suite_id: "color-palette",
          compute_nl_judge: true,
          max_concurrency: 1,
          requests_per_minute: 60,
        },
        "jobPalE2E",
      );

      const run = db.getRun("jobPalE2E")!;
      expect(run.status).toBe("finished");
      expect(run.total).toBe(3);
      expect(run.completed).toBe(3);
      const metrics = db.getMetrics("jobPalE2E");
      const names = (stage: string) =>
        [...new Set(metrics.filter((m) => m.stage === stage).map((m) => m.metric_name))].sort();
      expect(names("colorPalette")).toEqual(
        ["distinguishability", "divergingStructure", "gradientSmoothness", "groundTruthValidity"],
      );
      expect(names("llmJudge")).toEqual(["design", "relevance", "valid"]);
      // The judge saw the palette type each case asked for.
      expect(prompts.length).toBe(3);
      expect(prompts.some((p) => p.includes("Requested Palette Type: `diverging`"))).toBe(true);
      const types = eventTypes("jobPalE2E");
      expect(types[0]).toBe("start");
      expect(types[1]).toBe("skeletons");
      expect(types.at(-1)).toBe("done");
      expect(types.filter((t) => t === "row").length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a 5xx palette error is a transient failure; a 501 (feature off) is not", () => {
    const row = (description: string): RowPayload => ({
      test_case_id: "x", runner: "color-palettes-server", datasource: null, utterance: "",
      turn: 0, expected: {}, actual: {}, latency: null, metrics: {}, debug_info: {}, info: {},
      errors: [{ phase: "RUN_TEST", description, warning: false }],
    });
    expect(isTransientFailure(row("Bad response (500): model gateway failed"))).toBe(true);
    expect(
      isTransientFailure(
        row("Color palette generation is not enabled for this site on this server (501): off"),
      ),
    ).toBe(false);
  });

  it("an empty dashboard summary fails the case but is not retried", () => {
    // The same request would get the same answer: no retry.
    const row: RowPayload = {
      test_case_id: "dn", runner: "dashboard-viz-narrative-config", datasource: null, utterance: "",
      turn: 0, expected: {}, actual: {}, latency: null, metrics: {}, debug_info: {}, info: {},
      errors: [{ phase: "RUN_TEST", description: EMPTY_SUMMARY_ERROR, warning: false }],
    };
    expect(isFailedCase(row)).toBe(true);
    expect(isTransientFailure(row)).toBe(false);
  });
});

describe("friendlyFailure (df34aa0d _friendly_failure)", () => {
  it("names a suite that could not be loaded", () => {
    const msg = friendlyFailure(new Error("No runnable prep test cases found in /x"));
    expect(msg).toStartWith("The test suite could not be loaded: No runnable prep test cases");
    expect(msg).toContain("evaluate again");
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    expect(friendlyFailure(enoent)).toStartWith("The test suite could not be loaded");
  });

  it("passes a token error through as is", () => {
    const e = new TableauAuthError("Tableau Server didn't accept the PAT (401)");
    expect(friendlyFailure(e)).toBe("Tableau Server didn't accept the PAT (401)");
  });

  it("says a network failure is the network", () => {
    const e = Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
    const msg = friendlyFailure(e);
    expect(msg).toStartWith("Tableau Server could not be reached (Unable to connect)");
    expect(msg).toContain("Evaluation Setup, step 1");
  });

  it("passes an adapter's stopped-run reason through as is", () => {
    const text = "3 questions in a row failed the same way, so the rest were not asked. Down.";
    expect(friendlyFailure(new Error(text))).toBe(text);
  });

  it("names anything else and points at the terminal", () => {
    const msg = friendlyFailure(new Error("boom"));
    expect(msg).toBe(
      "The evaluation stopped before it finished: boom. The tool's output (the " +
        "terminal where it was started) has the details.",
    );
  });
});

// The job reads formulas from both answer shapes.
describe("formulaOf", () => {
  it("reads formulas from both answer shapes", () => {
    expect(formulaOf({ calculatedFieldFormula: { formula: "SUM([Sales])", caption: "x" } })).toBe("SUM([Sales])");
    expect(formulaOf({ calculation: "[Profit] / [Sales]" })).toBe("[Profit] / [Sales]");
    expect(formulaOf({ notionalSpec: { chart: "bar" } })).toBeNull();
    expect(formulaOf({ calculatedFieldFormula: { formula: "" } })).toBeNull();
  });
});
