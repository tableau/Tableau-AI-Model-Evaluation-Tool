/**
 * SSE state / event-log accessor.
 *
 * Combines the DB event log (durable) with an in-process `EventNotifier`
 * (wakeup), and exposes:
 *   - `appendEvent`  — persist an event line and wake live tails.
 *   - `streamEvents` — an async generator that replays past events then tails
 *                      new ones.
 *
 * The stored payload is the exact compact-JSON line the SSE stream emits, so
 * replay and live tailing are byte-for-byte identical (same invariant the
 * `append_event` documents).
 */

import type { AiEvalDb } from "../db/index.ts";
import { EventNotifier } from "./notifier.ts";

export interface EmittedEvent {
  id: number;
  type: string;
  payload: string; // compact JSON line
}

export class SseState {
  #db: AiEvalDb;
  #notifier = new EventNotifier();

  constructor(db: AiEvalDb) {
    this.#db = db;
  }

  get notifier(): EventNotifier {
    return this.#notifier;
  }

  /**
   * Append one streamed event to the durable log and wake live streams.
   * `payload` is serialized with compact separators (no spaces), matching the
   * Python `json.dumps(payload, separators=(",", ":"))`.
   */
  appendEvent(job_id: string, payload: Record<string, unknown>): number {
    const line = JSON.stringify(payload);
    const id = this.#db.appendEvent(
      job_id,
      (payload.type as string) ?? "",
      line,
    );
    this.#notifier.notifyAll();
    return id;
  }

  /** One-shot read of persisted events after `afterId`. */
  getEvents(job_id: string, afterId = 0, types?: string[]): EmittedEvent[] {
    return this.#db.getEvents(job_id, afterId, types);
  }

  /**
   * Async generator that yields events for `job_id` in emit order: first any
   * already-persisted events after `afterId`, then live-tails new ones. Ends
   * when `signal` aborts or a terminal event type is seen.
   *
   * @param terminalTypes event types that end the stream once emitted
   * @param pollMs        bounded wait per idle cycle (Python `wait_for_events`)
   */
  async *streamEvents(
    job_id: string,
    opts: {
      afterId?: number;
      signal?: AbortSignal;
      terminalTypes?: string[];
      pollMs?: number;
    } = {},
  ): AsyncGenerator<EmittedEvent> {
    let lastId = opts.afterId ?? 0;
    const pollMs = opts.pollMs ?? 1000;
    const terminal = new Set(opts.terminalTypes ?? []);

    while (!opts.signal?.aborted) {
      const batch = this.#db.getEvents(job_id, lastId);
      for (const ev of batch) {
        lastId = ev.id;
        yield ev;
        if (terminal.has(ev.type)) return;
      }
      if (opts.signal?.aborted) return;
      // Bounded wait: released by the next append OR after pollMs.
      await this.#notifier.wait(pollMs);
    }
  }
}

/** Format one event as an SSE wire frame (`data: <line>\n\n`, with id). */
export function toSseFrame(ev: EmittedEvent): string {
  return `id: ${ev.id}\ndata: ${ev.payload}\n\n`;
}
