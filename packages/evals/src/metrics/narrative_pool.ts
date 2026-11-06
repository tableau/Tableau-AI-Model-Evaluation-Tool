/** Bounded CPU pool shared by all narrative runs, not one pool per request. */
import { availableParallelism } from "node:os";
import type { MetricEntry } from "@tableau-ai-eval/core";
import { NARRATIVE_METRIC_GROUPS, type NarrativeMetricGroup } from "./narrative.ts";

export interface NarrativeWorkerRequest {
  id: number;
  group: NarrativeMetricGroup;
  views: unknown[];
  expected: unknown;
  actual: unknown;
}

export interface NarrativeWorkerResponse {
  id: number;
  metrics?: MetricEntry[];
  error?: string;
}

interface Task {
  request: NarrativeWorkerRequest;
  resolve: (metrics: MetricEntry[]) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  task?: Task;
}

// Compiled entrypoints retain their project-relative path and use .js. The
// importing module itself is folded into the main executable at the root.
const defaultWorkerUrl = Bun.isStandaloneExecutable
  ? new URL("./packages/evals/src/metrics/narrative_worker.js", import.meta.url)
  : new URL("./narrative_worker.ts", import.meta.url);

export class NarrativeScoringPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 0;
  private closed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly size = Math.max(1, Math.min(4, availableParallelism() - 1)),
    private readonly workerUrl = defaultWorkerUrl,
  ) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error("Worker pool size must be a positive integer");
  }

  async compute(views: unknown[], expected: unknown, actual: unknown): Promise<MetricEntry[]> {
    if (this.closed) throw new Error("Narrative scoring pool is closed");
    // Captures include large base64 dashboard/view images. These metrics only
    // read outliers and insights: do not clone pictures into four worker heaps.
    const metricViews = views.map((raw) => {
      const view = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const artifacts = Array.isArray(view.artifacts)
        ? view.artifacts.filter((raw) => {
            if (!raw || typeof raw !== "object") return false;
            const type = (raw as Record<string, unknown>).artifactType;
            return type === "OUTLIERS" || type === "PULSE_INSIGHTS";
          })
        : [];
      return { name: view.name, artifacts };
    });
    // Promise.all preserves evaluator order even when groups finish out of order.
    const pending = Promise.all(
      NARRATIVE_METRIC_GROUPS.map(
        (group) =>
          new Promise<MetricEntry[]>((resolve, reject) => {
            this.queue.push({
              request: { id: ++this.nextId, group, views: metricViews, expected, actual },
              resolve,
              reject,
            });
          }),
      ),
    );
    this.drain();
    const groups = await pending;
    return groups.flat();
  }

  private spawn(): Slot {
    const worker = new Worker(this.workerUrl.href);
    const slot: Slot = { worker };
    worker.onmessage = (event: MessageEvent<NarrativeWorkerResponse>) => {
      const task = slot.task;
      if (!task || event.data.id !== task.request.id) return;
      slot.task = undefined;
      if (event.data.error) task.reject(new Error(event.data.error));
      else if (event.data.metrics) task.resolve(event.data.metrics);
      else task.reject(new Error("Narrative worker returned no metrics"));
      worker.unref();
      this.drain();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(slot, new Error(event.message || "Narrative scoring worker failed"));
    };
    worker.addEventListener("close", () =>
      this.fail(slot, new Error("Narrative scoring worker exited")),
    );
    this.slots.push(slot);
    return slot;
  }

  private fail(slot: Slot, error: Error): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    this.slots.splice(index, 1);
    slot.task?.reject(error);
    slot.worker.terminate();
    this.drain();
  }

  private drain(): void {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    while (this.queue.length) {
      let slot = this.slots.find((candidate) => !candidate.task);
      if (!slot && this.slots.length >= this.size) break;
      try {
        slot ??= this.spawn();
        const task = this.queue.shift()!;
        slot.task = task;
        slot.worker.ref();
        slot.worker.postMessage(task.request);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (slot) this.fail(slot, failure);
        else this.queue.shift()?.reject(failure);
      }
    }
    if (!this.queue.length && this.slots.every((slot) => !slot.task)) {
      // Release idle heaps, but keep warm workers between adjacent cases.
      this.idleTimer = setTimeout(() => {
        for (const slot of this.slots.splice(0)) slot.worker.terminate();
      }, 30000);
      this.idleTimer.unref();
    }
  }

  close(): void {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const error = new Error("Narrative scoring pool is closed");
    for (const task of this.queue.splice(0)) task.reject(error);
    for (const slot of this.slots.splice(0)) {
      slot.task?.reject(error);
      slot.worker.terminate();
    }
  }
}

const sharedPool = new NarrativeScoringPool();

export function computeNarrativeMetricsAsync(
  views: unknown[],
  expected: unknown,
  actual: unknown,
): Promise<MetricEntry[]> {
  return sharedPool.compute(views, expected, actual);
}
