import { afterEach, beforeEach, expect, test } from "bun:test";
import { AiEvalDb, SseState } from "@tableau-ai-eval/core";
import { JobQueue } from "../worker/queue.ts";
import { createRoutesContext } from "./context.ts";
import { observeRun } from "./observe.ts";
import { postBatchCancel, postBatchPause } from "./runs.ts";
import type { RoutesContext } from "./context.ts";

let ctx: RoutesContext;
beforeEach(() => {
  const db = new AiEvalDb(":memory:"); db.initDb();
  ctx = createRoutesContext({ db, sse: new SseState(db),
    queue: new JobQueue({ acquireInhibitor: () => ({ release() {} }) }) });
  db.createRun({ job_id: "r", org_id: "", user_id: "", ai_feature: "", runner_name: "fake",
    config: { batch_id: "batch" } });
  ctx.lifecycle.patch("r", { status: "queued" });
});
afterEach(() => ctx.db.close());

test("observation starts at current state and catches a commit between snapshot and delivery", async () => {
  const execution = ctx.lifecycle.begin("r")!;
  ctx.lifecycle.patch("r", { completed: 1 }, execution);
  const abort = new AbortController();
  const response = observeRun(ctx, "r", new Request("http://x", { signal: abort.signal }));
  const revision = ctx.lifecycle.snapshot("r")!.revision;
  ctx.lifecycle.stop("r", "paused"); // committed before the browser consumes its snapshot
  const reader = response.body!.getReader();
  try {
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    expect(first.type).toBe("snapshot");
    expect(first.projection.revision).toBe(revision);
    expect(first.projection.run.completed).toBe(1);
    const second = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    expect(second.type).toBe("change");
    expect(second.revision).toBe(revision + 1);
    expect(second.run.status).toBe("paused");
    ctx.lifecycle.resume("r");
    const third = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    expect(third.run.status).toBe("queued"); // pause never closed the subscription
  } finally {
    abort.abort(); await reader.cancel();
  }
});

test("batch pause commits queued and executing suites before aborting the worker", async () => {
  ctx.lifecycle.begin("r");
  ctx.db.createRun({ job_id: "next", org_id: "", user_id: "", ai_feature: "", runner_name: "fake",
    config: { batch_id: "batch" } });
  const controller = new AbortController();
  let observed: unknown;
  controller.signal.addEventListener("abort", () => {
    observed = [ctx.db.getRun("r")?.status, ctx.db.getRun("next")?.status];
  });
  ctx.orchestratorDeps.runControllers!.set("r", controller);
  const response = postBatchPause(ctx, "batch");
  expect(await response.json()).toEqual({ ok: true, paused: 2 });
  expect(observed).toEqual(["paused", "paused"]);
});

test("batch cancel commits every unfinished suite, paused included, before aborting the worker", async () => {
  ctx.lifecycle.begin("r");
  for (const id of ["next", "held", "done"]) ctx.db.createRun({ job_id: id, org_id: "", user_id: "",
    ai_feature: "", runner_name: "fake", config: { batch_id: "batch" } });
  ctx.lifecycle.patch("held", { status: "paused" });
  ctx.lifecycle.patch("done", { status: "finished" });
  ctx.db.createRun({ job_id: "other", org_id: "", user_id: "", ai_feature: "", runner_name: "fake",
    config: { batch_id: "elsewhere" } });
  const controller = new AbortController();
  let observed: unknown;
  controller.signal.addEventListener("abort", () => {
    observed = ["r", "next", "held"].map(id => ctx.db.getRun(id)?.status);
  });
  ctx.orchestratorDeps.runControllers!.set("r", controller);
  const response = postBatchCancel(ctx, "batch");
  expect(await response.json()).toEqual({ ok: true, cancelled: 3 });
  expect(observed).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(ctx.db.getRun("done")?.status).toBe("finished");
  expect(ctx.db.getRun("other")?.status).not.toBe("cancelled");
  expect(postBatchCancel(ctx, "batch").status).toBe(409);
});
