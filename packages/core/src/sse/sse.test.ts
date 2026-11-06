import { test, expect, beforeEach, afterEach } from "bun:test";
import { AiEvalDb } from "../db/index.ts";
import { SseState } from "./state.ts";
import { EventNotifier } from "./notifier.ts";
import { startSseServer } from "./server.ts";

let db: AiEvalDb;
let state: SseState;

beforeEach(() => {
  db = new AiEvalDb(":memory:");
  db.initDb();
  state = new SseState(db);
});

afterEach(() => {
  db.close();
});

test("notifier releases waiter on notifyAll", async () => {
  const n = new EventNotifier();
  let resolved = false;
  const p = n.wait(5000).then(() => {
    resolved = true;
  });
  expect(n.waiterCount).toBe(1);
  n.notifyAll();
  await p;
  expect(resolved).toBe(true);
  expect(n.waiterCount).toBe(0);
});

test("notifier releases waiter on timeout", async () => {
  const n = new EventNotifier();
  const start = Date.now();
  await n.wait(30);
  expect(Date.now() - start).toBeGreaterThanOrEqual(25);
});

test("one-shot getEvents returns appended events in order", () => {
  state.appendEvent("job-1", { type: "progress", n: 1 });
  state.appendEvent("job-1", { type: "progress", n: 2 });
  state.appendEvent("job-2", { type: "progress", n: 99 }); // other job
  state.appendEvent("job-1", { type: "done" });

  const evs = state.getEvents("job-1");
  expect(evs.map((e) => e.type)).toEqual(["progress", "progress", "done"]);
  // ids strictly increasing
  expect(evs[0].id).toBeLessThan(evs[1].id);
  expect(evs[1].id).toBeLessThan(evs[2].id);
  // payload is the exact compact-JSON line
  expect(evs[0].payload).toBe('{"type":"progress","n":1}');
});

test("deleteEvents removes only the named types for the named job", () => {
  state.appendEvent("job-a", { type: "row", n: 1 });
  state.appendEvent("job-a", { type: "done", status: "paused" });
  state.appendEvent("job-b", { type: "done", status: "paused" }); // other job
  // Remove job-a's done (what resume does); the row and job-b are untouched.
  expect(db.deleteEvents("job-a", ["done"])).toBe(1);
  expect(db.getEvents("job-a").map((e) => e.type)).toEqual(["row"]);
  expect(db.getEvents("job-b").map((e) => e.type)).toEqual(["done"]);
  // Empty type list is a no-op.
  expect(db.deleteEvents("job-a", [])).toBe(0);
});

test("streamEvents replays past then tails live, in order, ends on terminal", async () => {
  // Pre-existing (replay) events.
  state.appendEvent("job-3", { type: "start" });
  state.appendEvent("job-3", { type: "progress", n: 1 });

  const received: string[] = [];
  const consumer = (async () => {
    for await (const ev of state.streamEvents("job-3", {
      terminalTypes: ["done"],
      pollMs: 1000,
    })) {
      received.push(ev.type);
    }
  })();

  // Give the consumer a tick to drain the replay, then append live events.
  await Bun.sleep(20);
  state.appendEvent("job-3", { type: "progress", n: 2 });
  await Bun.sleep(20);
  state.appendEvent("job-3", { type: "done" });

  await consumer;
  expect(received).toEqual(["start", "progress", "progress", "done"]);
});

test("HTTP SSE endpoint streams events in order to a fetch consumer", async () => {
  const server = startSseServer(state, {
    terminalTypes: ["done"],
    pollMs: 1000,
  });
  try {
    const url = `http://localhost:${server.port}/nlq-eval/events/job-http`;

    // Seed one replay event, then start streaming.
    state.appendEvent("job-http", { type: "start", msg: "hi" });

    const res = await fetch(url);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Append live events after the request is open.
    const feeder = (async () => {
      await Bun.sleep(30);
      state.appendEvent("job-http", { type: "progress", n: 1 });
      await Bun.sleep(30);
      state.appendEvent("job-http", { type: "done" });
    })();

    const text = await res.text(); // resolves when stream closes (terminal)
    await feeder;

    // Parse SSE frames.
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice("data: ".length)));

    expect(dataLines.map((d) => d.type)).toEqual([
      "start",
      "progress",
      "done",
    ]);
    // id: lines present and increasing
    const ids = text
      .split("\n")
      .filter((l) => l.startsWith("id: "))
      .map((l) => Number(l.slice("id: ".length)));
    expect(ids.length).toBe(3);
    expect(ids[0]).toBeLessThan(ids[1]);
    expect(ids[1]).toBeLessThan(ids[2]);
  } finally {
    server.stop(true);
  }
});
