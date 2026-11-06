/**
 * In-process async event notifier used to wake SSE live-tail loops.
 *
 * The design is a condition variable: `append_event` calls
 * `notify_all()` and `wait_for_events(timeout)` blocks until notified or the
 * timeout elapses (so missed notifies degrade to short polling). Bun is
 * single-threaded with an event loop, so we replace the condition variable
 * with a set of pending promise resolvers plus a timeout, preserving the same
 * contract: a waiter is released by the next append OR after `timeout` ms.
 *
 * Events themselves are persisted by the DB layer (`events` table); this
 * notifier only signals "something changed, re-query the tail": durability lives in SQLite and the condition is
 * purely a wakeup.
 */

export class EventNotifier {
  #waiters = new Set<() => void>();

  /** Wake every current waiter. Called after an event is appended. */
  notifyAll(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolve on the next `notifyAll()`, or after `timeoutMs` — whichever comes
   * first. A spurious/late wakeup just makes the caller re-query an empty
   * tail.
   */
  wait(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.#waiters.delete(waiter);
        clearTimeout(timer);
        resolve();
      };
      const waiter = finish;
      const timer = setTimeout(finish, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  get waiterCount(): number {
    return this.#waiters.size;
  }
}
