import { beforeEach, afterEach, expect, test } from "bun:test";
import { AiEvalDb } from "./db/index.ts";
import { SseState } from "./sse/state.ts";
import { RunLifecycle } from "./run_lifecycle.ts";
import { applyRunChange, type ObservedResult } from "@tableau-ai-eval/run-state";

let db: AiEvalDb;
let lifecycle: RunLifecycle;
beforeEach(() => {
  db = new AiEvalDb(":memory:"); db.initDb();
  lifecycle = new RunLifecycle(db, new SseState(db));
  db.createRun({ job_id: "r", org_id: "", user_id: "", ai_feature: "", runner_name: "fake", config: {} });
});
afterEach(() => db.close());
const result: ObservedResult = { test_case_id: "a", runner: "fake", datasource: null,
  utterance: "hello", expected: {}, actual: { answer: "yes" }, latency: 1,
  metrics: {}, errors: [], debug_info: {}, info: {} };

test("result, counters and event commit together; projection matches a fresh snapshot", () => {
  const executionId = lifecycle.begin("r")!;
  lifecycle.commit("r", { cases: [result], run: { total: 1 }, runningIds: ["a"] }, { executionId });
  const before = lifecycle.snapshot("r")!;
  const event = lifecycle.commit("r", { results: [result], runningIds: [], run: { completed: 1 } },
    { executionId, write: () => db.persistCaseResult({ job_id: "r", ...result }, {}, []) })!;
  const projected = applyRunChange(before, event);
  const fresh = lifecycle.snapshot("r")!;
  expect(projected).toEqual(fresh);
  expect(db.getRun("r")?.completed).toBe(1);
  expect(db.getJobState("r").completed).toBe(1);
});

test("persistence failure rolls back result, lifecycle and event", () => {
  const executionId = lifecycle.begin("r")!;
  const before = lifecycle.snapshot("r")!;
  expect(() => lifecycle.commit("r", { results: [result], run: { completed: 1 } }, {
    executionId, write: () => {
      db.persistCaseResult({ job_id: "r", ...result }, {}, []);
      throw new Error("disk failure");
    },
  })).toThrow("disk failure");
  expect(lifecycle.snapshot("r")).toEqual(before);
  expect(lifecycle.changes("r", before.revision)).toEqual([]);
  expect(db.getResults("r")).toEqual([]);
});

test("pause/resume fences all old callbacks including teardown, even without a successful abort", () => {
  const old = lifecycle.begin("r")!;
  lifecycle.commit("r", { runningIds: ["a"] }, { executionId: old });
  lifecycle.stop("r", "paused");
  expect(lifecycle.snapshot("r")?.runningIds).toEqual([]);
  lifecycle.resume("r");
  const next = lifecycle.begin("r")!;
  lifecycle.commit("r", { runningIds: ["b"] }, { executionId: next });
  let written = false;
  expect(lifecycle.commit("r", { results: [result], run: { status: "finished" } }, {
    executionId: old, write: () => { written = true; },
  })).toBeNull();
  expect(lifecycle.patch("r", { running_case_ids: [], phase: null }, old)).toBeNull();
  expect(written).toBe(false);
  expect(lifecycle.snapshot("r")?.runningIds).toEqual(["b"]);
  expect(lifecycle.snapshot("r")?.run.status).toBe("started");
});

test("commands reject invalid transitions and duplicate begin cannot claim another execution", () => {
  expect(lifecycle.resume("r")).toBeNull();
  const execution = lifecycle.begin("r")!;
  expect(lifecycle.begin("r")).toBeNull();
  lifecycle.patch("r", { status: "finished" }, execution);
  expect(lifecycle.stop("r", "paused")).toBeNull();
  expect(lifecycle.stop("r", "cancelled")).toBeNull();
  expect(lifecycle.resume("r")).toBeNull();
});

test("retry invalidation is reflected identically by live change and fresh snapshot", () => {
  const executionId = lifecycle.begin("r")!;
  lifecycle.commit("r", { results: [result], run: { completed: 1 } }, {
    executionId, write: () => db.persistCaseResult({ job_id: "r", ...result }, {}, []),
  });
  const before = lifecycle.snapshot("r")!;
  const event = lifecycle.commit("r", { resetIds: ["a"], retryingIds: ["a"], run: { completed: 0 } }, {
    executionId, write: () => db.deleteTestCaseResults("r", ["a"]),
  })!;
  expect(applyRunChange(before, event)).toEqual(lifecycle.snapshot("r")!);
});

test("startup recovery revokes the abandoned execution and deletion removes observation storage", () => {
  const old = lifecycle.begin("r")!;
  lifecycle.commit("r", { runningIds: ["a"] }, { executionId: old });
  const restarted = new RunLifecycle(db, new SseState(db));
  restarted.stop("r", "paused");
  expect(restarted.patch("r", { status: "finished" }, old)).toBeNull();
  expect(restarted.snapshot("r")?.runningIds).toEqual([]);
  expect(db.deleteRun("r")).toBe(true);
  expect(restarted.snapshot("r")).toBeNull();
  expect(restarted.changes("r", 0)).toEqual([]);
});
