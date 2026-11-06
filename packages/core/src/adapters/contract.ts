/**
 * Runner-adapter contract.
 *
 * One tool-side contract over the eval harnesses, so the Prep bench
 * and the CABU harness can plug in beside NLQ without
 * touching the orchestrator.
 *
 * Division of labor:
 * - The ORCHESTRATOR owns everything harness-agnostic: run records, the SSE
 *   event stream, resume skip-lists, pause/cancel control, SQLite persistence,
 *   judge attachment.
 * - An ADAPTER owns everything harness-specific: environment setup, suite
 *   loading, and case execution. Adapters emit normalized per-case result
 *   objects (the `RowPayload` shape) through a callback — they never touch
 *   SQLite or the event log directly.
 *
 * `session()` provides a lifecycle seam. Harness invocation uses injectable,
 * path-explicit interfaces, without process-global CWD or credential mutation.
 */

/**
 * The per-case result object contract — what `emitCase` receives. This is the
 * existing "row" payload that the metrics engine + db layer consume.
 *
 * Normalized case shape:
 * test_case_id, runner, datasource, utterance, turn, expected, actual,
 * latency, errors, metrics {stage: [entries]}, debug_info, info.
 */
export interface MetricEntry {
  metric_id: string;
  metric_name: string;
  score: number | null;
  explanation: string | null;
}

export interface RowError {
  phase: string;
  description: string;
  warning: boolean;
  [key: string]: unknown;
}

export interface RowPayload {
  test_case_id: string;
  runner: string;
  datasource: string | null;
  utterance: string;
  turn: number;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  latency: number | null;
  errors: RowError[];
  /** stage -> list of metric entries */
  metrics: Record<string, MetricEntry[]>;
  debug_info: Record<string, unknown>;
  info: Record<string, unknown>;
}

/**
 * The lightweight projection emitted up-front in the SSE `skeletons` event —
 * only the inputs knowable before the model runs.
 */
export interface CaseSkeleton {
  test_case_id: string;
  runner: string;
  datasource: string | null;
  utterance: string;
  expected: Record<string, unknown>;
}

/**
 * `emitCase(serializedResult)` — orchestrator callback per completed case.
 */
export type EmitCase = (row: RowPayload) => Promise<void>;

/**
 * `shouldStop()` — returns null | 'pause' | 'cancel'. Adapters check it at case
 * boundaries and stop scheduling new cases when set.
 */
export type ShouldStop = () => string | null;

/**
 * What the orchestrator needs to know about a loaded suite before execution:
 * totals and skeletons for the SSE contract, and conversation structure (as
 * case-id groups) for the resume skip-list. `opaque` carries the adapter's
 * private execution structures.
 *
 * Mirrors the `SuitePlan` dataclass.
 */
export interface SuitePlan {
  total: number;
  skeletons: CaseSkeleton[];
  /** Each conversation is a list of its case ids (conversation granularity). */
  conversation_ids: string[][];
  opaque?: unknown;
  /**
   * Set by the orchestrator before execute(): an adapter calls it with a case
   * id when it starts working on that case, so the results page can tell the
   * cases in flight from the ones still waiting. Optional: an adapter that
   * never calls it only loses that distinction.
   */
  case_started?: ((caseId: string) => void) | null;
}

/** A run config is an untyped key/value bag. */
export type RunConfig = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Concurrency / rate settings (bug bash 2026-09-23: runs were slow because
// every case waited for the previous one although the server answers
// independent requests independently).
// ---------------------------------------------------------------------------

/**
 * Three at a time roughly triples throughput against the harness default rate
 * cap (2 requests per 10 s) without exceeding it; higher values only queue on
 * the limiter unless requests_per_minute is raised as well.
 */
export const DEFAULT_MAX_CONCURRENCY = 3;
/**
 * Env kill switch (public naming; formerly a deliberate divergence away from
 * `TABLEAU_AI_EVAL_*`): `TABLEAU_AI_EVAL_MAX_CONCURRENCY=1` restores sequential runs.
 */
export const MAX_CONCURRENCY_ENV = "TABLEAU_AI_EVAL_MAX_CONCURRENCY";

/**
 * Conversations in flight at once for this run: the environment variable wins
 * (the kill switch: 1 restores sequential runs), then the run's
 * `max_concurrency`, then the default. Clamped to 1..16.
 */
export function resolveMaxConcurrency(config: RunConfig): number {
  let raw: unknown = process.env[MAX_CONCURRENCY_ENV];
  if (raw === undefined || raw === "") raw = (config || {}).max_concurrency;
  if (raw === undefined || raw === "" || raw === null) raw = DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(String(raw), 10);
  if (Number.isNaN(n)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(16, n));
}

/** Optional per-run request rate. null means "use the harness default". */
export function resolveRequestsPerMinute(config: RunConfig): number | null {
  const raw = (config || {}).requests_per_minute;
  if (raw === undefined || raw === "" || raw === null) return null;
  const n = Number.parseInt(String(raw), 10);
  if (Number.isNaN(n)) return null;
  return Math.max(1, Math.min(60, n));
}

/**
 * A session lifecycle handle. `session()`
 * returns a disposable whose `close()` runs teardown (the `finally` block).
 */
export interface AdapterSession {
  close(): Promise<void> | void;
}

/**
 * The contract every harness adapter implements.
 */
export interface EvalAdapter {
  readonly id: string;

  /**
   * Set up the harness environment; entered before `load()` and held through
   * `execute()`. The returned handle's `close()` performs teardown.
   * This does not change the process working directory or write credential files.
   */
  session(config: RunConfig, jobId: string): Promise<AdapterSession> | AdapterSession;

  /**
   * Discover and load the suite. Throws when no runnable cases are found (the
   * orchestrator surfaces it as a failed run).
   */
  load(config: RunConfig): Promise<SuitePlan> | SuitePlan;

  /**
   * Run the suite: for each case not skipped via `completedIds`
   * (conversation-granularity — skip only when EVERY case id of the
   * conversation is completed), execute + evaluate, then `await emitCase(row)`.
   * Check `shouldStop()` at case boundaries and return promptly when it is set.
   */
  execute(
    plan: SuitePlan,
    config: RunConfig,
    emitCase: EmitCase,
    shouldStop: ShouldStop,
    completedIds: Set<string>,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _REGISTRY = new Map<string, EvalAdapter>();

/** Register an adapter under its `id`. */
export function register(adapter: EvalAdapter): void {
  _REGISTRY.set(adapter.id, adapter);
}

/** Clear the registry (test helper). */
export function _clearRegistry(): void {
  _REGISTRY.clear();
}

/** Default adapter id. */
export const DEFAULT_ADAPTER_ID = "nlq";

/**
 * Resolve the adapter for a run config (`adapter` key, default nlq).
 *
 * In the monorepo split, the concrete adapters live in `@tableau-ai-eval/evals`. `core`
 * must not depend on `evals` (that would be a package cycle), so the old
 * `_LAZY_ADAPTER_MODULES` self-import table is gone: the registry is populated
 * by `@tableau-ai-eval/evals`' `registerAdapters()`, which the server invokes once at
 * startup. `getAdapter` therefore just reads the registry and throws a
 * `ValueError`-shaped error for an unknown/unregistered id.
 */
export async function getAdapter(config: RunConfig): Promise<EvalAdapter> {
  const adapterId =
    (typeof config.adapter === "string" && config.adapter) || DEFAULT_ADAPTER_ID;

  const adapter = _REGISTRY.get(adapterId);
  if (!adapter) {
    const registered = [..._REGISTRY.keys()].sort();
    throw new Error(
      `Unknown eval adapter ${JSON.stringify(adapterId)} ` +
        `(registered: [${registered.map((r) => JSON.stringify(r)).join(", ")}])`,
    );
  }
  return adapter;
}
