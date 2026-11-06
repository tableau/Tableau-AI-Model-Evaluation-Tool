import { expect, test } from "bun:test";
import { AiEvalDb, RunLifecycle, SseState } from "@tableau-ai-eval/core";
import type { ServerWebSocket } from "bun";
import { observationSocket, type ObservationSocketData } from "./observation_socket.ts";
import type { ObservationMessage } from "@tableau-ai-eval/run-state";

test("socket snapshots and durable revisions multiplex, survive pause, and fence subscriptions", async () => {
  const db = new AiEvalDb(":memory:"); db.initDb();
  const sse = new SseState(db);
  const lifecycle = new RunLifecycle(db, sse);
  for (const jobId of ["a", "b"]) {
    db.createRun({ job_id: jobId, org_id: "", user_id: "", ai_feature: "", runner_name: "", config: {} });
    lifecycle.patch(jobId, { status: "queued" });
  }
  const messages: ObservationMessage[] = [];
  const ws = { data: { subscriptions: new Map(), closed: false },
    send(raw: string) { messages.push(JSON.parse(raw)); return raw.length; }, close() {} } as unknown as ServerWebSocket<ObservationSocketData>;
  const handler = observationSocket(db, sse);
  const subscribe = (jobId: string, subscriptionId: string) => handler.message(ws, JSON.stringify({ type: "subscribe", jobId, subscriptionId }));
  try {
    subscribe("a", "a1"); subscribe("b", "b1");
    const execution = lifecycle.begin("a")!; // committed while snapshot is in transit
    const pump = handler.open(ws);
    expect(messages.some(m => "message" in m && m.message.type === "change" && m.message.executionId === execution)).toBe(true);
    lifecycle.stop("a", "paused");
    await Bun.sleep(10);
    expect(messages.some(m => "message" in m && m.message.type === "change" && m.message.run?.status === "paused")).toBe(true);
    expect(ws.data.subscriptions.size).toBe(2);
    subscribe("a", "a2");
    handler.message(ws, JSON.stringify({ type: "unsubscribe", jobId: "a", subscriptionId: "a1" }));
    expect(ws.data.subscriptions.get("a")?.subscriptionId).toBe("a2");
    lifecycle.resume("a");
    await Bun.sleep(10);
    expect(messages.some(m => "message" in m && m.subscriptionId === "a2" && m.message.type === "change" && m.message.run?.status === "queued")).toBe(true);
    handler.close(ws); await pump;
    expect(sse.notifier.waiterCount).toBe(0);
  } finally { handler.close(ws); db.close(); }
});

test("a dropped message disconnects instead of skipping committed revisions; a queued one does not", () => {
  const db = new AiEvalDb(":memory:"); db.initDb();
  const handler = observationSocket(db, new SseState(db));
  // Bun's send returns 0 for a message it dropped: the subscriber must
  // reconnect for a fresh snapshot rather than miss a revision.
  let code = 0;
  const dropped = { data: { subscriptions: new Map(), closed: false }, send() { return 0; },
    close(value: number) { code = value; } } as unknown as ServerWebSocket<ObservationSocketData>;
  // -1 is a message queued under backpressure, which every large snapshot
  // is on a fresh connection; it is delivered, so nothing is lost (2026-10-29:
  // treating it as a drop closed every results page of a run over ~0.5 MB).
  let queuedClosed = false;
  const queued = { data: { subscriptions: new Map(), closed: false }, send() { return -1; },
    close() { queuedClosed = true; } } as unknown as ServerWebSocket<ObservationSocketData>;
  try {
    handler.message(dropped, JSON.stringify({ type: "subscribe", jobId: "unknown", subscriptionId: "1" }));
    expect(code).toBe(1013);
    expect(dropped.data.closed).toBe(true);
    handler.message(queued, JSON.stringify({ type: "subscribe", jobId: "unknown", subscriptionId: "1" }));
    expect(queuedClosed).toBe(false);
    expect(queued.data.closed).toBe(false);
  } finally { db.close(); }
});
