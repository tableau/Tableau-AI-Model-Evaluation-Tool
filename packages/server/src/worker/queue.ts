/**
 * In-process sequential job queue for evaluation runs.
 *
 * This is an **async serial queue**, not a separate thread — one
 * job runs to completion (awaited) before the next starts, matching the
 * sequential execution contract. Submission is fire-and-forget;
 * progress is observable through the job_state table and the SSE event log,
 * and pausing stops new cases through the control flag. User-requested pause
 * and cancellation also abort network calls and rate-limit waits; the
 * queue still awaits orderly teardown before starting the next job.
 * CPU-heavy narrative scoring uses its own bounded Worker pool so this queue
 * and the HTTP server's event loop stay responsive.
 *
 * Each job holds a best-effort sleep inhibitor for its duration
 * (`sleep_inhibit.ts`).
 *
 * API:
 *   - `submit(fn, ...args)`  — queue a job for sequential execution.
 *   - `ensureStarted()`      — start the drain loop if idle (no-op if running).
 *   - `pendingCount()`       — jobs queued but not yet finished (incl. running).
 *   - `isAlive()`            — true while the drain loop is active.
 *   - `waitIdle(timeoutMs?)` — resolve when the queue drains (test/shutdown).
 */

import { inhibitSleep, type SleepInhibitor } from "./sleep_inhibit.ts";

/** A queued job: a function plus its already-bound arguments. */
type Job = () => Promise<void> | void;

export interface JobQueueOptions {
  /** Injectable sleep-inhibitor acquire (tests pass a no-op). Default: real. */
  acquireInhibitor?: () => SleepInhibitor;
  /** Called when a job throws (kept alive for the next job). Default: console.error. */
  onError?: (err: unknown) => void;
}

export class JobQueue {
  #queue: Job[] = [];
  #running = false;
  #inFlight = false;
  #idleWaiters: Array<() => void> = [];
  #acquireInhibitor: () => SleepInhibitor;
  #onError: (err: unknown) => void;

  constructor(opts: JobQueueOptions = {}) {
    this.#acquireInhibitor = opts.acquireInhibitor ?? inhibitSleep;
    this.#onError =
      opts.onError ??
      ((err) => {
        // Job entrypoints handle their own failure bookkeeping; this guard
        // only keeps the drain loop alive for the next job.
        console.error("worker: job crashed", err);
      });
  }

  /**
   * Start the drain loop if it is not already running. Idempotent — matches
   * `ensure_started`. The loop awaits each job (holding a sleep inhibitor)
   * before pulling the next, then goes idle when the queue empties.
   */
  ensureStarted(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue[0]!;
        this.#inFlight = true;
        const inhibitor = this.#acquireInhibitor();
        try {
          await job();
        } catch (err) {
          this.#onError(err);
        } finally {
          inhibitor.release();
          // Remove only after completion so pendingCount reflects the
          // running job too (matches queue.qsize semantics + task_done).
          this.#queue.shift();
          this.#inFlight = false;
        }
      }
    } finally {
      this.#running = false;
      this.#wakeIdleWaiters();
    }
  }

  #wakeIdleWaiters(): void {
    if (this.#queue.length > 0 || this.#inFlight) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Queue a job for sequential execution and ensure the drain loop is running.
   * `fn` is invoked with `args`; wrap async work so rejections are captured by
   * the loop's guard. Mirrors `submit(fn, *args)`.
   */
  submit<A extends unknown[]>(
    fn: (...args: A) => Promise<void> | void,
    ...args: A
  ): void {
    this.#queue.push(() => fn(...args));
    this.ensureStarted();
  }

  /** Jobs queued but not yet finished, including the one running. */
  pendingCount(): number {
    return this.#queue.length;
  }

  /** True while the drain loop is active. */
  isAlive(): boolean {
    return this.#running;
  }

  /**
   * Resolve when the queue has fully drained. With a `timeoutMs`, resolves
   * after the timeout even if jobs remain.
   */
  waitIdle(timeoutMs?: number): Promise<void> {
    if (this.#queue.length === 0 && !this.#inFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.#idleWaiters.push(finish);
      const timer =
        timeoutMs !== undefined ? setTimeout(finish, timeoutMs) : null;
    });
  }
}
