/** Browser-safe observation protocol. Commands are decided only by the server. */
export type RunStatus = "queued" | "started" | "paused" | "finished" | "failed" | "cancelled";

export interface ObservedRun {
  job_id: string;
  status: RunStatus;
  total: number;
  completed: number;
  config: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ObservedCase {
  test_case_id: string;
  runner: string;
  datasource: string | null;
  utterance: string;
  expected: unknown;
}

export interface ObservedResult extends ObservedCase {
  actual: unknown;
  latency: number | null;
  metrics: Record<string, Array<{
    metric_id: string;
    metric_name: string;
    score: number | null;
    explanation: string | null;
  }>>;
  errors: Array<{ phase: string; description: string; warning: boolean }>;
  debug_info: unknown;
  info: unknown;
}

export interface RunProjection {
  jobId: string;
  revision: number;
  executionId: string;
  run: ObservedRun;
  state: Record<string, unknown>;
  cases: ObservedCase[];
  results: Record<string, ObservedResult>;
  runningIds: string[];
  retryingIds: string[];
}

/** One committed change-set: result, lifecycle and progress move together. */
export interface RunChange {
  type: "change";
  jobId: string;
  revision: number;
  executionId: string;
  run?: Partial<ObservedRun>;
  state?: Record<string, unknown>;
  cases?: ObservedCase[];
  results?: ObservedResult[];
  resetIds?: string[];
  runningIds?: string[];
  retryingIds?: string[];
}

export interface RunSnapshot {
  type: "snapshot";
  projection: RunProjection;
}

/** Transport subscriptions are independent of lifecycle/execution identity. */
export type ObservationCommand = {
  type: "subscribe" | "unsubscribe";
  jobId: string;
  subscriptionId: string;
};
export type ObservationMessage = {
  subscriptionId: string;
  message: RunSnapshot | RunChange;
} | { subscriptionId: string; error: string } | { type: "heartbeat" };

export class RevisionGap extends Error {
  constructor() { super("Run observation revision gap"); }
}

export function isExecuting(status: RunStatus): boolean {
  return status === "started";
}

/** Pure projection shared by the server and browser. No effects or decisions. */
export function applyRunChange(current: RunProjection, change: RunChange): RunProjection {
  if (change.jobId !== current.jobId) throw new Error("Run observation identity mismatch");
  if (change.revision <= current.revision) return current;
  if (change.revision !== current.revision + 1) throw new RevisionGap();
  const run = { ...current.run, ...change.run };
  const results = { ...current.results };
  for (const id of change.resetIds ?? []) delete results[id];
  for (const row of change.results ?? []) results[row.test_case_id] = row;
  const settled = new Set(Object.keys(results));
  const runningIds = isExecuting(run.status)
    ? (change.runningIds ?? current.runningIds).filter(id => !settled.has(id))
    : [];
  const retryingIds = (change.retryingIds ?? current.retryingIds).filter(id => !settled.has(id));
  return {
    ...current,
    revision: change.revision,
    executionId: change.executionId,
    run,
    state: { ...current.state, ...change.state, status: run.status,
      total: run.total, completed: run.completed, running_case_ids: runningIds,
      retrying_case_ids: retryingIds },
    cases: change.cases ?? current.cases,
    results,
    runningIds,
    retryingIds,
  };
}
