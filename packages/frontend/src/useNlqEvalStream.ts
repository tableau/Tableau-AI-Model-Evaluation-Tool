/** Current snapshot on every connection, then committed incremental changes.
 * No status/results arbitration, historical replay, or terminal-event reload.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { observationTransport } from "./observationTransport";
import { applyRunChange, type RunProjection, type RunChange,
  type RunSnapshot } from "@tableau-ai-eval/run-state";
import type { NlqEvalRun, NlqEvalTableRow, NlqEvalAggregateMetrics } from "./nlqEvalTypes";
import type { RunRecord } from "./evaluationGroups";

export interface NlqEvalState {
  status: "loading" | "streaming" | "done" | "error";
  run: NlqEvalRun | null;
  rows: NlqEvalTableRow[];
  aggregateMetrics: NlqEvalAggregateMetrics;
  runState: Record<string, any> | null;
  error?: string;
  jobId?: string;
  confirmed?: boolean;
  revision?: number;
  connection?: "loading" | "connected" | "reconnecting" | "error";
}

const EMPTY_AGGREGATE: NlqEvalAggregateMetrics = {
  totalCases: 0, completedCases: 0, avgIntentEquals: null, avgSpecEquals: null,
  avgPrecision: null, avgRecall: null, avgFieldValidity: null, avgLatency: null,
  errorCount: 0, warningCount: 0,
};

function aggregates(rows: NlqEvalTableRow[]): NlqEvalAggregateMetrics {
  const completed = rows.filter(r => !r.pending);
  const avg = (values: (number | null)[]) => {
    const valid = values.filter((v): v is number => v !== null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  };
  return { totalCases: rows.length, completedCases: completed.length,
    avgIntentEquals: avg(completed.map(r => r.intentEquals)),
    avgSpecEquals: avg(completed.map(r => r.specEquals)),
    avgPrecision: avg(completed.map(r => r.specPrecision)),
    avgRecall: avg(completed.map(r => r.specRecall)),
    avgFieldValidity: avg(completed.map(r => r.specFieldValidity)),
    avgLatency: avg(completed.map(r => r.latency)),
    errorCount: completed.filter(r => r.errors.some(e => !e.is_warning)).length,
    warningCount: completed.filter(r => r.errors.length && r.errors.every(e => e.is_warning)).length,
  };
}

/** Rendering adapter only; lifecycle is projected by the shared reducer. */
function toView(projection: RunProjection, connection: NlqEvalState["connection"]): NlqEvalState {
  const cases = [...projection.cases];
  const known = new Set(cases.map(c => c.test_case_id));
  for (const result of Object.values(projection.results)) if (!known.has(result.test_case_id)) cases.push(result);
  const running = new Set(projection.runningIds);
  const retrying = new Set(projection.retryingIds);
  const rows: NlqEvalTableRow[] = cases.map(c => {
    const r = projection.results[c.test_case_id];
    const metrics = r?.metrics ?? {};
    const score = (stage: string, name: string) => metrics[stage]?.find(m => m.metric_name === name)?.score ?? null;
    return { key: c.test_case_id, test_case_id: c.test_case_id, runner: c.runner,
      datasource: c.datasource, utterance: c.utterance,
      expected: c.expected as NlqEvalTableRow["expected"],
      actual: r?.actual as NlqEvalTableRow["actual"] ?? null,
      latency: r?.latency ?? null, metricsByStage: metrics,
      pending: !r, running: !r && running.has(c.test_case_id),
      retrying: !r && retrying.has(c.test_case_id),
      intentEquals: score("intent", "equals"), specEquals: score("notionalSpec", "equals"),
      specPrecision: score("notionalSpec", "precision"), specRecall: score("notionalSpec", "recall"),
      specFieldValidity: score("notionalSpec", "fieldValidity"),
      errors: (r?.errors ?? []).map(e => ({ phase: e.phase, description: e.description, is_warning: e.warning })),
      debug_info: r?.debug_info as NlqEvalTableRow["debug_info"] ?? null,
      info: r?.info as NlqEvalTableRow["info"] ?? null,
    };
  });
  const active = ["queued", "started"].includes(projection.run.status);
  return { jobId: projection.jobId, revision: projection.revision, confirmed: true,
    connection, run: projection.run as unknown as NlqEvalRun,
    runState: projection.state, rows, aggregateMetrics: aggregates(rows),
    status: active ? "streaming" : projection.run.status === "failed" ? "error" : "done",
    error: projection.run.status === "failed" ? String(projection.run.error || "The evaluation failed") : undefined,
  };
}

/** One store per run, shared by all mounted UI consumers. Tabs select identity;
 * they never merge another run's state. Connections are reference-counted.
 */
export class RunObservationStore {
  private projection: RunProjection | null = null;
  private view: NlqEvalState;
  private listeners = new Set<() => void>();
  private releaseTransport: (() => void) | null = null;
  private consumers = 0;
  private generation = 0;

  constructor(readonly jobId: string) {
    this.view = { jobId, status: "loading", run: null, runState: null, rows: [],
      aggregateMetrics: { ...EMPTY_AGGREGATE }, confirmed: false, connection: "loading" };
  }

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(view: NlqEvalState) {
    this.view = view;
    this.listeners.forEach(listener => listener());
  }

  /** Public for deterministic snapshot/event fixtures; throws on a gap. */
  ingest(message: RunSnapshot | RunChange) {
    if (message.type === "snapshot") {
      if (message.projection.jobId !== this.jobId) throw new Error("Wrong run snapshot");
      if (this.projection && message.projection.revision < this.projection.revision) {
        this.publish(toView(this.projection, "connected"));
        return;
      }
      // A snapshot replaces rows, including results invalidated by a retry.
      this.projection = message.projection;
    } else {
      if (!this.projection) throw new Error("Change before snapshot");
      this.projection = applyRunChange(this.projection, message);
    }
    this.publish(toView(this.projection, "connected"));
  }

  retain() {
    this.consumers += 1;
    if (this.consumers === 1) this.reload();
    return () => {
      this.consumers -= 1;
      if (!this.consumers) this.cancel();
    };
  }

  cancel = () => {
    this.generation += 1;
    this.releaseTransport?.();
    this.releaseTransport = null;
  };

  get retained(): boolean { return this.consumers > 0; }

  reload = () => {
    this.cancel();
    const generation = this.generation;
    // A deliberate reload (a failed control action, a component watching
    // the run again) keeps the connection as it was: the rows on screen are
    // the last confirmed ones either way, and "Reconnecting" is for a
    // connection the transport reports lost.
    this.publish({ ...this.view, confirmed: false,
      connection: this.projection ? this.view.connection : "loading" });
    this.releaseTransport = observationTransport.subscribe(this.jobId,
      message => { if (generation === this.generation) this.ingest(message); },
      (connection, error) => {
        if (generation !== this.generation) return;
        this.publish({ ...this.view, confirmed: false, connection,
          ...(error ? { status: "error", error } : {}) });
      });
  };

}

const stores = new Map<string, RunObservationStore>();
export function observationStore(jobId: string): RunObservationStore {
  let store = stores.get(jobId);
  if (!store) {
    store = new RunObservationStore(jobId); stores.set(jobId, store);
    for (const [id, cached] of stores) {
      if (stores.size <= 16) break;
      if (id !== jobId && !cached.retained) stores.delete(id);
    }
  }
  return store;
}
const empty = new RunObservationStore("");

export function useNlqEvalStream(jobId: string | undefined) {
  const store = jobId ? observationStore(jobId) : empty;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => jobId ? store.retain() : undefined, [jobId, store]);
  const reload = useCallback(() => { if (jobId) store.reload(); }, [jobId, store]);
  return { state, reload, cancel: store.cancel };
}

/** Suite tabs/header subscribe to the same stores as the selected result table.
 * The list endpoint discovers membership; it cannot overwrite observed status.
 */
export function useObservedRunRecords<T extends RunRecord>(records: T[]): T[] {
  const [version, tick] = useState(0);
  const ids = records.filter(r => ["queued", "started", "paused"].includes(r.status)).map(r => r.job_id).join("\n");
  useEffect(() => {
    const releases = ids.split("\n").filter(Boolean).flatMap(id => {
      const store = observationStore(id);
      return [store.subscribe(() => tick(n => n + 1)), store.retain()];
    });
    return () => releases.forEach(release => release());
  }, [ids]);
  return useMemo(() => records.map(record => {
    const view = observationStore(record.job_id).getSnapshot();
    if (!view.run) return record;
    return { ...record, ...view.runState, status: view.run.status,
      completed: view.run.completed, total: view.run.total,
      error: view.run.error, revision: view.revision };
  }), [records, version]);
}
