/**
 * Tests for the async serial job queue + sleep inhibitor.
 */

import { describe, expect, it } from "bun:test";
import { JobQueue } from "./queue.ts";
import { inhibitSleep } from "./sleep_inhibit.ts";

const noopInhibitor = () => ({ release() {} });

describe("JobQueue", () => {
  it("runs jobs one at a time, in order, to completion", async () => {
    const q = new JobQueue({ acquireInhibitor: noopInhibitor });
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeJob = (name: string) => async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      order.push(name);
      concurrent -= 1;
    };

    q.submit(makeJob("a"));
    q.submit(makeJob("b"));
    q.submit(makeJob("c"));

    await q.waitIdle();
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxConcurrent).toBe(1); // strictly sequential
  });

  it("ensureStarted is idempotent while running", async () => {
    const q = new JobQueue({ acquireInhibitor: noopInhibitor });
    let ran = 0;
    q.submit(async () => {
      await new Promise((r) => setTimeout(r, 20));
      ran += 1;
    });
    expect(q.isAlive()).toBe(true);
    q.ensureStarted();
    q.ensureStarted();
    await q.waitIdle();
    expect(ran).toBe(1);
    expect(q.isAlive()).toBe(false);
  });

  it("pendingCount reflects queued + running jobs", async () => {
    const q = new JobQueue({ acquireInhibitor: noopInhibitor });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    q.submit(async () => {
      await gate;
    });
    q.submit(async () => {});
    q.submit(async () => {});
    expect(q.pendingCount()).toBe(3); // running + 2 queued
    release();
    await q.waitIdle();
    expect(q.pendingCount()).toBe(0);
  });

  it("a crashing job does not kill the worker", async () => {
    const errors: unknown[] = [];
    const q = new JobQueue({
      acquireInhibitor: noopInhibitor,
      onError: (e) => errors.push(e),
    });
    const ran: string[] = [];
    q.submit(async () => {
      throw new Error("boom");
    });
    q.submit(async () => {
      ran.push("survivor");
    });
    await q.waitIdle();
    expect(errors.length).toBe(1);
    expect(ran).toEqual(["survivor"]);
  });

  it("waitIdle resolves immediately when queue is empty", async () => {
    const q = new JobQueue({ acquireInhibitor: noopInhibitor });
    await q.waitIdle(); // should not hang
    expect(q.pendingCount()).toBe(0);
  });

  it("waitIdle honors a timeout even if jobs remain", async () => {
    const q = new JobQueue({ acquireInhibitor: noopInhibitor });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    q.submit(async () => {
      await gate;
    });
    const start = Date.now();
    await q.waitIdle(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    expect(q.pendingCount()).toBe(1); // still running
    release();
    await q.waitIdle();
  });

  it("acquires and releases a sleep inhibitor per job", async () => {
    let acquired = 0;
    let released = 0;
    const q = new JobQueue({
      acquireInhibitor: () => {
        acquired += 1;
        return {
          release() {
            released += 1;
          },
        };
      },
    });
    q.submit(async () => {});
    q.submit(async () => {});
    await q.waitIdle();
    expect(acquired).toBe(2);
    expect(released).toBe(2);
  });
});

describe("inhibitSleep", () => {
  it("returns a releasable handle and never throws", () => {
    const h = inhibitSleep();
    expect(typeof h.release).toBe("function");
    // release is idempotent
    h.release();
    h.release();
  });

  it.if(process.platform === "win32")(
    "holds and releases the Win32 wake lock via bun:ffi",
    () => {
      // On Windows the inhibitor binds kernel32!SetThreadExecutionState. A
      // non-throwing acquire+release round-trip exercises the real FFI path.
      const h = inhibitSleep();
      expect(typeof h.release).toBe("function");
      h.release();
      h.release();
    },
  );
});
