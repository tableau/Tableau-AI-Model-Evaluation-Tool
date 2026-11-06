/**
 * Shared shape types for the SQLite persistence layer's read paths.
 *
 * These describe the row/result objects the `AiEvalDb` read methods return,
 * so consumers (routes, the export builder) can drop the `as unknown as …`
 * casts they previously needed against loose `Record<string, unknown>`
 * returns.
 *
 * Ownership note: the DB layer lives in `@tableau-ai-eval/core` and PRODUCES these
 * shapes, so the canonical definitions live here (not in `@tableau-ai-eval/server`).
 * `@tableau-ai-eval/server`'s export builder re-imports them from `@tableau-ai-eval/core`.
 *
 * This module is intentionally pure type declarations with NO runtime imports,
 * so it can be imported by `db/index.ts` without any circular-import risk.
 *
 * Several of these carry a `[key: string]: unknown` index signature because
 * the DB rows are `SELECT *` bags that also get extra dynamic keys grafted on
 * at runtime (e.g. `getResults` attaches a `metrics` map, `listRuns` derives
 * `model_name`/`batch_id`, `getJobState` is a free-form JSON blob). The index
 * signature keeps existing dynamic property access at call sites compiling
 * without a cascade of casts.
 */

/** A metric row as stored by the DB (one per test case × metric). */
export interface MetricRow {
  test_case_id: string;
  stage: string;
  metric_name: string;
  metric_id?: string | null;
  score: number | null;
  explanation?: string | null;
  [key: string]: unknown;
}

/** An error row associated with a test case. */
export interface ErrorRow {
  test_case_id: string;
  description?: string | null;
  phase?: string | null;
  [key: string]: unknown;
}

/** A per-case result row as stored by the DB. */
export interface ResultRow {
  test_case_id: string;
  runner?: string | null;
  datasource?: string | null;
  utterance?: string | null;
  expected?: unknown;
  actual?: unknown;
  latency?: number | null;
  [key: string]: unknown;
}

/** The run record (`SELECT * FROM runs`), config parsed from JSON. */
export interface RunRecord {
  status?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
  org_id?: string | null;
  ai_feature?: string | null;
  runner_name?: string | null;
  config?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** The `db.getFullResults(job_id)` shape. */
export interface FullResults {
  run: RunRecord;
  metrics: MetricRow[];
  errors: ErrorRow[];
  results: ResultRow[];
}

/**
 * The persisted job-state blob (`db.getJobState(job_id)`). A free-form JSON
 * bag; the fields below are the ones the export/state overlay code reads by
 * name, the rest are reachable through the index signature.
 */
export interface JobState {
  status?: string | null;
  total?: number | null;
  completed?: number | null;
  judge_provider?: string | null;
  judge_model?: string | null;
  [key: string]: unknown;
}

/**
 * The live-run state consumed by the export builder. Structurally a subset of
 * {@link JobState}; kept as its own name for the `state` read.
 */
export interface RunState {
  status?: string | null;
  total?: number | null;
  judge_provider?: string | null;
  judge_model?: string | null;
  [key: string]: unknown;
}

/**
 * A run summary row from `db.listRuns(limit)`. The `config` blob is dropped and
 * replaced by derived display fields (`model_name`, `batch_id`, …). Routes also
 * synthesize rows of this shape from free-form job state, so every field beyond
 * the `job_id` key is typed `unknown` (values originate from an untyped JSON
 * bag); the index signature covers additional dynamic overlay keys.
 */
export interface RunListRow {
  job_id: string;
  org_id?: unknown;
  ai_feature?: unknown;
  runner_name?: unknown;
  status?: unknown;
  total?: unknown;
  completed?: unknown;
  error?: unknown;
  created_at?: unknown;
  finished_at?: unknown;
  model_name?: unknown;
  batch_id?: unknown;
  suite_id?: unknown;
  suite_label?: unknown;
  [key: string]: unknown;
}
