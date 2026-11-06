/**
 * SQLite persistence layer using `bun:sqlite`.
 *
 * Schema init (WAL mode), and the core write/read paths for
 * runs, test_results, test_metrics, test_errors, plus job_state / events /
 * settings accessors that the SSE core needs. Secret redaction, the
 * scrub migration, and the richer history queries (list_runs, run_scores)
 * are deferred to later phases — they are additive and not compile-critical.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { SCHEMA } from "./schema.ts";
import type {
  ErrorRow,
  FullResults,
  JobState,
  MetricRow,
  ResultRow,
  RunListRow,
  RunRecord,
} from "./types.ts";
// Secret masking/redaction lives in ../tableau/credentials.ts (the canonical
// source). Imported for internal use (insertRun config redaction). NOT
// re-exported from db — the barrel surfaces maskValue/redactSecrets via
// credentials.ts, giving a single export path and no `export *` collision.
import { redactSecrets } from "../tableau/credentials.ts";
import * as mc from "../metrics/catalog.ts";

/** Run statuses that never change again (their history score is cached). */
const TERMINAL_STATUSES = new Set(["finished", "failed", "cancelled"]);
/** Bump when the history score's definition changes (invalidates caches). */
// 4: headline scores carry total_scores / judge_scores.
const SCORE_VERSION = 4;

/**
 * What a cached run score was computed with: the scoring code's version and
 * the metric catalog's content. Either changing makes every cached score
 * stale.
 */
function scoreVersion(): string {
  return `${SCORE_VERSION}:${mc.fingerprint()}`;
}

/** One run's history scores (see `runScores`). */
export interface RunScore {
  score: number | null;
  scored_metrics: number;
  headline_scores: mc.HeadlineScore[];
}

/**
 * A metric explanation as one string (null stays null). Some harness metrics
 * return a list of findings or a dict, which SQLite cannot bind; flatten them
 * so a single such metric never loses the whole case's metrics.
 */
export function explanationText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map((v) => String(v));
    return parts.length ? parts.join("; ") : null;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * A metric score as a number or null; anything else is unscored (booleans count as 1/0, non-numeric strings → null).
 */
export function scalarScore(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface CreateRunArgs {
  job_id: string;
  org_id: string;
  user_id: string;
  ai_feature: string;
  runner_name: string;
  config: unknown;
}

export interface TestResultRow {
  job_id: string;
  test_case_id: string;
  runner: string | null;
  datasource: string | null;
  utterance: string | null;
  expected: unknown;
  actual: unknown;
  latency: number | null;
  debug_info?: unknown;
  /**
   * Pre-serialized `debug_info` JSON. When provided, it is stored verbatim and
   * `debug_info` is NOT re-serialized (the caller already stringified it, e.g.
   * to measure/truncate size — avoids a second JSON.stringify of a large blob).
   */
  debug_info_json?: string | null;
  info?: unknown;
}

export interface MetricInput {
  metric_id?: string | null;
  id?: string | null;
  metric_name?: string | null;
  name?: string | null;
  score?: unknown;
  explanation?: unknown;
}

export interface ErrorInput {
  phase?: string | null;
  description?: string | null;
  warning?: boolean;
}

export class AiEvalDb {
  readonly db: Database;

  // Lazily-prepared insert statements (prepared once, after initDb). bun:sqlite
  // caches by SQL text too, but hoisting removes per-call closure/transaction
  // allocation on the hot per-case persist path (1000+ cases/run).
  private _insResult?: ReturnType<Database["query"]>;
  private _insMetric?: ReturnType<Database["query"]>;
  private _insError?: ReturnType<Database["query"]>;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    // Connection PRAGMAs.
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
  }

  /** Create tables if they don't exist. Safe to call multiple times. */
  initDb(): void {
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Upsert a run row (not REPLACE), preserving created_at / progress counters
   * on resume — an ON CONFLICT DO UPDATE upsert.
   * NOTE: secret redaction of `config` is deferred to a later phase.
   */
  createRun(args: CreateRunArgs): void {
    this.db
      .query(
        `INSERT INTO runs
           (job_id, org_id, user_id, ai_feature, runner_name, config, status)
           VALUES ($job_id, $org_id, $user_id, $ai_feature, $runner_name, $config, 'queued')
           ON CONFLICT(job_id) DO UPDATE SET
             org_id = excluded.org_id,
             user_id = excluded.user_id,
             ai_feature = excluded.ai_feature,
             runner_name = excluded.runner_name,
             config = excluded.config,
             status = 'queued',
             error = NULL,
             finished_at = NULL`,
      )
      .run({
        $job_id: args.job_id,
        $org_id: args.org_id,
        $user_id: args.user_id,
        $ai_feature: args.ai_feature,
        $runner_name: args.runner_name,
        $config: JSON.stringify(redactSecrets(args.config)),
      });
  }

  /** Complete run identity without ever persisting unredacted credentials. */
  updateRunConfig(jobId: string, patch: Record<string, unknown>): void {
    const run = this.getRun(jobId);
    if (!run) return;
    this.db.query("UPDATE runs SET config = ? WHERE job_id = ?").run(
      JSON.stringify(redactSecrets({ ...run.config, ...patch })), jobId,
    );
  }

  updateRunStatus(
    job_id: string,
    status: string,
    opts: {
      total?: number;
      completed?: number;
      error?: string;
    } = {},
  ): void {
    const parts = ["status = $status"];
    const params: Record<
      string,
      string | bigint | NodeJS.TypedArray | number | boolean | null
    > = { $status: status };
    if (opts.total !== undefined) {
      parts.push("total = $total");
      params.$total = opts.total;
    }
    if (opts.completed !== undefined) {
      parts.push("completed = $completed");
      params.$completed = opts.completed;
    }
    if (opts.error !== undefined) {
      parts.push("error = $error");
      params.$error = opts.error;
    }
    if (status === "finished" || status === "failed" || status === "cancelled") {
      parts.push("finished_at = datetime('now')");
    }
    params.$job_id = job_id;
    this.db
      .query(`UPDATE runs SET ${parts.join(", ")} WHERE job_id = $job_id`)
      .run(params);
  }

  // -- prepared insert statements + single-row writers ----------------------

  private resultStmt(): ReturnType<Database["query"]> {
    this._insResult ??= this.db.query(
      `INSERT INTO test_results
         (job_id, test_case_id, runner, datasource, utterance,
          expected, actual, latency, debug_info, info)
         VALUES ($job_id, $test_case_id, $runner, $datasource, $utterance,
                 $expected, $actual, $latency, $debug_info, $info)`,
    );
    return this._insResult;
  }

  private metricStmt(): ReturnType<Database["query"]> {
    this._insMetric ??= this.db.query(
      `INSERT INTO test_metrics
         (job_id, test_case_id, stage, metric_id, metric_name, score, explanation)
         VALUES ($job_id, $test_case_id, $stage, $metric_id, $metric_name, $score, $explanation)`,
    );
    return this._insMetric;
  }

  private errorStmt(): ReturnType<Database["query"]> {
    this._insError ??= this.db.query(
      `INSERT INTO test_errors
         (job_id, test_case_id, phase, description, is_warning)
         VALUES ($job_id, $test_case_id, $phase, $description, $is_warning)`,
    );
    return this._insError;
  }

  private writeResultRow(r: TestResultRow): void {
    // Prefer a caller-supplied pre-serialized debug_info (avoids a second
    // JSON.stringify of a potentially large blob); else serialize here.
    const debugInfoJson =
      r.debug_info_json !== undefined
        ? r.debug_info_json
        : r.debug_info
          ? JSON.stringify(r.debug_info)
          : null;
    this.resultStmt().run({
      $job_id: r.job_id,
      $test_case_id: r.test_case_id,
      $runner: r.runner,
      $datasource: r.datasource,
      $utterance: r.utterance,
      $expected: r.expected ? JSON.stringify(r.expected) : null,
      $actual: r.actual ? JSON.stringify(r.actual) : null,
      $latency: r.latency,
      $debug_info: debugInfoJson,
      $info: r.info ? JSON.stringify(r.info) : null,
    });
  }

  private writeMetricRows(
    job_id: string,
    test_case_id: string,
    stage: string,
    metrics: MetricInput[],
  ): void {
    const stmt = this.metricStmt();
    for (const m of metrics) {
      stmt.run({
        $job_id: job_id,
        $test_case_id: test_case_id,
        $stage: stage,
        $metric_id: m.metric_id ?? m.id ?? null,
        $metric_name: m.metric_name ?? m.name ?? null,
        // `explanation` is TEXT and `score` REAL in the schema, but some
        // harness metrics return a list of findings (calcValidity: one string
        // per validation problem) or a dict; SQLite cannot bind those, and one
        // such metric used to lose the whole case's metrics (bug bash
        // 2026-09-23 live run). Flatten defensively.
        $score: scalarScore(m.score),
        $explanation: explanationText(m.explanation),
      });
    }
  }

  private writeErrorRows(
    job_id: string,
    test_case_id: string,
    errors: ErrorInput[],
  ): void {
    const stmt = this.errorStmt();
    for (const e of errors) {
      stmt.run({
        $job_id: job_id,
        $test_case_id: test_case_id,
        $phase: e.phase ?? null,
        $description: e.description ?? null,
        $is_warning: e.warning ? 1 : 0,
      });
    }
  }

  insertTestResult(r: TestResultRow): void {
    this.writeResultRow(r);
  }

  insertTestMetrics(
    job_id: string,
    test_case_id: string,
    stage: string,
    metrics: MetricInput[],
  ): void {
    const tx = this.db.transaction((rows: MetricInput[]) =>
      this.writeMetricRows(job_id, test_case_id, stage, rows),
    );
    tx(metrics);
  }

  insertTestErrors(
    job_id: string,
    test_case_id: string,
    errors: ErrorInput[],
  ): void {
    const tx = this.db.transaction((rows: ErrorInput[]) =>
      this.writeErrorRows(job_id, test_case_id, rows),
    );
    tx(errors);
  }

  /**
   * Persist one case's result + all its stage metrics + errors in a SINGLE
   * transaction (one fsync-bounded write per case instead of 2+ implicit
   * transactions). `metricsByStage` is the RowPayload.metrics map
   * (stage → metric list); empty stages are skipped.
   */
  persistCaseResult(
    r: TestResultRow,
    metricsByStage: Record<string, MetricInput[]>,
    errors: ErrorInput[] = [],
  ): void {
    const tx = this.db.transaction(() => {
      this.writeResultRow(r);
      for (const [stage, list] of Object.entries(metricsByStage)) {
        if (list && list.length) {
          this.writeMetricRows(r.job_id, r.test_case_id, stage, list);
        }
      }
      if (errors.length) {
        this.writeErrorRows(r.job_id, r.test_case_id, errors);
      }
    });
    tx();
  }

  // -------------------------------------------------------------------------
  // Job state / control / events / settings
  // -------------------------------------------------------------------------

  getJobState(job_id: string): JobState {
    const row = this.db
      .query<{ state: string }, [string]>(
        "SELECT state FROM job_state WHERE job_id = ?",
      )
      .get(job_id);
    if (!row) return {};
    try {
      return JSON.parse(row.state) as JobState;
    } catch {
      return {};
    }
  }

  patchJobState(
    job_id: string,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = { ...this.getJobState(job_id), ...patch };
    this.db
      .query(
        `INSERT INTO job_state (job_id, state, updated_at)
           VALUES ($job_id, $state, datetime('now'))
           ON CONFLICT(job_id) DO UPDATE SET
             state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run({ $job_id: job_id, $state: JSON.stringify(merged) });
    return merged;
  }

  setJobControl(job_id: string, control: string | null): void {
    this.db
      .query(
        `INSERT INTO job_state (job_id, control, updated_at)
           VALUES ($job_id, $control, datetime('now'))
           ON CONFLICT(job_id) DO UPDATE SET
             control = excluded.control, updated_at = excluded.updated_at`,
      )
      .run({ $job_id: job_id, $control: control });
  }

  getJobControl(job_id: string): string | null {
    const row = this.db
      .query<{ control: string | null }, [string]>(
        "SELECT control FROM job_state WHERE job_id = ?",
      )
      .get(job_id);
    return row ? row.control : null;
  }

  /** Append one event line; returns its sequence id (rowid). */
  appendEvent(job_id: string, event_type: string, payload_json: string): number {
    const res = this.db
      .query(
        "INSERT INTO events (job_id, type, payload) VALUES ($job_id, $type, $payload)",
      )
      .run({ $job_id: job_id, $type: event_type, $payload: payload_json });
    return Number(res.lastInsertRowid);
  }

  /** Events for a job in emit order, optionally after an id / filtered by type. */
  getEvents(
    job_id: string,
    after_id = 0,
    types?: string[],
  ): Array<{ id: number; type: string; payload: string }> {
    let sql = "SELECT id, type, payload FROM events WHERE job_id = ? AND id > ?";
    const params: SQLQueryBindings[] = [job_id, after_id];
    if (types && types.length) {
      sql += ` AND type IN (${types.map(() => "?").join(",")})`;
      params.push(...types);
    }
    sql += " ORDER BY id";
    return this.db
      .query<{ id: number; type: string; payload: string }, SQLQueryBindings[]>(sql)
      .all(...params);
  }

  /**
   * Remove a job's events of the given types; returns how many went. Used when
   * a run is resumed: the pause left a durable `done` line in the log, and
   * every later connection would replay it and close before the live events
   */
  deleteEvents(job_id: string, types: string[]): number {
    if (!types.length) return 0;
    const res = this.db
      .query(
        `DELETE FROM events WHERE job_id = ? AND type IN (${types.map(() => "?").join(",")})`,
      )
      .run(job_id, ...types);
    return Number(res.changes);
  }

  getSetting<T = unknown>(key: string, def: T | null = null): T | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM settings WHERE key = ?",
      )
      .get(key);
    if (!row) return def;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return def;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO settings (key, value, updated_at)
           VALUES ($key, $value, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ $key: key, $value: JSON.stringify(value) });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private parseJsonFields<T extends Record<string, unknown>>(
    row: T,
    fields: string[],
  ): T {
    for (const f of fields) {
      const v = row[f];
      if (typeof v === "string") {
        try {
          (row as Record<string, unknown>)[f] = JSON.parse(v);
        } catch {
          // leave as-is
        }
      }
    }
    return row;
  }

  getRun(job_id: string): RunRecord | null {
    const row = this.db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM runs WHERE job_id = ?",
      )
      .get(job_id);
    if (!row) return null;
    return this.parseJsonFields(row, ["config"]) as RunRecord;
  }

  getResults(job_id: string): ResultRow[] {
    return this.buildResults(job_id, this.getMetrics(job_id));
  }

  /**
   * Assemble result rows with their stage-grouped metrics joined in. Takes an
   * already-fetched `metrics` array so callers that also need the flat metrics
   * list (getFullResults) don't re-query test_metrics.
   */
  private buildResults(job_id: string, metrics: MetricRow[]): ResultRow[] {
    const rows = this.db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM test_results WHERE job_id = ? ORDER BY id",
      )
      .all(job_id);
    // Join test_metrics back into each row as a stage-grouped `metrics` map so
    // a row payload is self-describing (`row.metrics[stage] = [ComputedMetric]`),
    // matching the SSE `row` event shape (serializeCase) and the frontend's
    // `metricsByStage`. Without this join a persisted row's `metrics` reads as
    // null/absent even though the metrics ARE stored in test_metrics.
    const byCase = this.metricsByCaseStage(metrics);
    return rows.map((r) => {
      const parsed = this.parseJsonFields(r, [
        "expected",
        "actual",
        "debug_info",
        "info",
      ]);
      parsed.metrics = byCase.get(String(parsed.test_case_id)) ?? {};
      return parsed as ResultRow;
    });
  }

  /**
   * Group already-fetched metric rows by test_case_id → stage → ordered metric
   * list. Shared by the results join and any caller needing the per-case view.
   */
  private metricsByCaseStage(
    metrics: MetricRow[],
  ): Map<string, Record<string, Array<Record<string, unknown>>>> {
    const out = new Map<string, Record<string, Array<Record<string, unknown>>>>();
    for (const m of metrics) {
      const caseId = String(m.test_case_id);
      const stage = String(m.stage);
      let stages = out.get(caseId);
      if (!stages) {
        stages = {};
        out.set(caseId, stages);
      }
      stages[stage] ??= [];
      stages[stage].push({
        metric_id: m.metric_id ?? null,
        metric_name: m.metric_name,
        score: m.score ?? null,
        explanation: m.explanation ?? null,
      });
    }
    return out;
  }

  getMetrics(job_id: string): MetricRow[] {
    return this.db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM test_metrics WHERE job_id = ? ORDER BY id",
      )
      .all(job_id) as MetricRow[];
  }

  getErrors(job_id: string): ErrorRow[] {
    return this.db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM test_errors WHERE job_id = ? ORDER BY id",
      )
      .all(job_id) as ErrorRow[];
  }

  // -------------------------------------------------------------------------
  // History / resume / lifecycle accessors for routes and orchestration.
  // -------------------------------------------------------------------------

  /** True when a job_state row exists. */
  hasJobState(job_id: string): boolean {
    const row = this.db
      .query<{ one: number }, [string]>(
        "SELECT 1 AS one FROM job_state WHERE job_id = ?",
      )
      .get(job_id);
    return row !== null;
  }

  /**
   * Every job-state blob keyed by job id, newest-first. Queued jobs have no runs row, so the history merges
   * them in from here.
   */
  allJobStates(): Record<string, Record<string, unknown>> {
    const rows = this.db
      .query<{ job_id: string; state: string }, []>(
        "SELECT job_id, state FROM job_state ORDER BY rowid DESC",
      )
      .all();
    const out: Record<string, Record<string, unknown>> = {};
    for (const r of rows) {
      try {
        out[r.job_id] = (JSON.parse(r.state) as Record<string, unknown>) ?? {};
      } catch {
        out[r.job_id] = {};
      }
    }
    return out;
  }

  /**
   * Each run's scores for the history table: `headline_scores` (the capability's own averages,
   * what the home page shows) and `score`, the metric catalog's WEIGHTED
   * overall — the same number the exports and the published datasource carry
   * (it used to be a plain mean of every metric, which disagreed with both).
   * Fractions 0-1, plus the number of scored metrics, so a caller can tell a
   * real 0.0 from an empty run. An ended run never changes, so its scores are
   * computed once and cached in job_state (`score_version`); live runs are
   * recomputed on every call. The kept score is tied to the metric catalog it
   * was computed from (`scoreVersion`), so a catalog change recomputes it.
   */
  runScores(job_ids: string[]): Record<string, RunScore> {
    if (!job_ids.length) return {};
    const marks = job_ids.map(() => "?").join(",");
    const runRows = this.db
      .query<{ job_id: string; status: string; ai_feature: string | null }, SQLQueryBindings[]>(
        `SELECT job_id, status, ai_feature FROM runs WHERE job_id IN (${marks})`,
      )
      .all(...job_ids);
    const statuses = new Map(runRows.map((r) => [r.job_id, r.status] as const));
    // The capability names its categories (Calculated Fields in Flows).
    const capabilities = new Map(runRows.map((r) => [r.job_id, r.ai_feature] as const));
    const version = scoreVersion();
    const out: Record<string, RunScore> = {};
    const toCompute: string[] = [];
    for (const jobId of job_ids) {
      const cached = statuses.has(jobId) ? this.getJobState(jobId) : {};
      if (
        TERMINAL_STATUSES.has(statuses.get(jobId) ?? "") &&
        cached.score_version === version &&
        "overall_score" in cached
      ) {
        out[jobId] = {
          score: (cached.overall_score as number | null) ?? null,
          scored_metrics: (cached.scored_metrics as number) || 0,
          headline_scores: (cached.headline_scores as mc.HeadlineScore[]) || [],
        };
      } else {
        toCompute.push(jobId);
      }
    }
    if (!toCompute.length) return out;
    const marks2 = toCompute.map(() => "?").join(",");
    const rows = this.db
      .query<MetricRow & { job_id: string }, SQLQueryBindings[]>(
        `SELECT job_id, test_case_id, stage, metric_name, score, metric_id
           FROM test_metrics WHERE job_id IN (${marks2}) ORDER BY id`,
      )
      .all(...toCompute);
    const perRun = new Map<string, Map<string, MetricRow[]>>();
    for (const r of rows) {
      const cases = perRun.get(r.job_id) ?? new Map<string, MetricRow[]>();
      perRun.set(r.job_id, cases);
      const list = cases.get(r.test_case_id) ?? [];
      cases.set(r.test_case_id, list);
      list.push(r);
    }
    for (const jobId of toCompute) {
      const cases = [...(perRun.get(jobId)?.values() ?? [])];
      const scoredMetrics = cases.reduce(
        (n, c) => n + c.filter((m) => m.score !== null && m.score !== undefined).length,
        0,
      );
      const aggregate = mc.computeAggregateBuckets(cases.map((c) => mc.stageMap(c)));
      const overall = mc.weightedOverall(aggregate);
      const headline = mc.headlineScores(aggregate, capabilities.get(jobId));
      out[jobId] = { score: overall, scored_metrics: scoredMetrics, headline_scores: headline };
      if (TERMINAL_STATUSES.has(statuses.get(jobId) ?? "")) {
        this.patchJobState(jobId, {
          overall_score: overall,
          scored_metrics: scoredMetrics,
          headline_scores: headline,
          score_version: version,
        });
      }
    }
    return out;
  }

  /**
   * Newest-first run summaries for the history panel.
   * Excludes the config blob but derives a display `model_name` / batch /
   * suite fields from it.
   */
  listRuns(limit = 50): RunListRow[] {
    const rows = this.db
      .query<Record<string, unknown>, [number]>(
        `SELECT job_id, org_id, ai_feature, runner_name, status,
                total, completed, error, created_at, finished_at, config
           FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit);
    for (const run of rows) {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse((run.config as string) || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        cfg = {};
      }
      delete run.config;
      run.batch_id = cfg.batch_id || null;
      run.suite_id = cfg.suite_id || null;
      run.suite_label = cfg.suite_label || null;
      const models = (cfg.models as Record<string, unknown>) || {};
      const declared = cfg.declared_site_model as string | undefined;
      const resolved = cfg.resolved_site_model as string | undefined;
      let modelName =
        (models.create as string) || (models.understand as string) || "";
      if (!modelName && resolved) modelName = resolved;
      if (!modelName && declared) modelName = `${declared} (declared)`;
      if (
        !modelName &&
        String(cfg.generations_mode || "").toLowerCase() === "ces"
      ) {
        modelName = "Site Settings model";
      }
      if (modelName) run.model_name = modelName;
    }
    return rows as RunListRow[];
  }

  /** job_ids of runs still active — orphan recovery at boot. */
  getActiveRunIds(): string[] {
    const rows = this.db
      .query<{ job_id: string }, []>(
        "SELECT job_id FROM runs WHERE status IN ('queued', 'started', 'running')",
      )
      .all();
    return rows.map((r) => r.job_id);
  }

  /** Distinct completed test-case ids for a job — the resume skip-list. */
  getCompletedTestCaseIds(job_id: string): string[] {
    const rows = this.db
      .query<{ test_case_id: string }, [string]>(
        "SELECT DISTINCT test_case_id FROM test_results WHERE job_id = ?",
      )
      .all(job_id);
    return rows.map((r) => r.test_case_id);
  }

  /**
   * Each persisted case of a job with its answer and run errors, in the shape
   * the orchestrator's classifiers read (`actual` parsed, errors as
   * `{description, warning}`). Lets a resume judge persisted rows the way the
   * run judged them as they landed.
   */
  getPersistedOutcomes(job_id: string): {
    test_case_id: string;
    actual: unknown;
    errors: { description: string; warning: boolean }[];
  }[] {
    const rows = this.db
      .query<{ test_case_id: string; actual: string | null }, [string]>(
        "SELECT test_case_id, actual FROM test_results WHERE job_id = ?",
      )
      .all(job_id);
    const errors = new Map<string, { description: string; warning: boolean }[]>();
    for (const e of this.db
      .query<{ test_case_id: string; description: string; is_warning: number }, [string]>(
        "SELECT test_case_id, description, is_warning FROM test_errors WHERE job_id = ?",
      )
      .all(job_id)) {
      const list = errors.get(e.test_case_id) ?? [];
      list.push({ description: e.description, warning: Boolean(e.is_warning) });
      errors.set(e.test_case_id, list);
    }
    return rows.map((r) => {
      let actual: unknown = {};
      if (r.actual) {
        try {
          actual = JSON.parse(r.actual);
        } catch {
          actual = r.actual;
        }
      }
      return { test_case_id: r.test_case_id, actual, errors: errors.get(r.test_case_id) ?? [] };
    });
  }

  /** Delete persisted rows for specific test cases of a job (partial-conversation resume). */
  deleteTestCaseResults(job_id: string, test_case_ids: string[]): void {
    if (!test_case_ids.length) return;
    const placeholders = test_case_ids.map(() => "?").join(",");
    const tx = this.db.transaction(() => {
      for (const table of ["test_errors", "test_metrics", "test_results"]) {
        this.db
          .query(
            `DELETE FROM ${table} WHERE job_id = ? AND test_case_id IN (${placeholders})`,
          )
          .run(job_id, ...test_case_ids);
      }
    });
    tx();
  }

  /**
   * Delete a run and all associated rows. Returns true
   * if something was deleted. A never-started job has state+events but no runs
   * row and is still deletable.
   */
  deleteRun(job_id: string): boolean {
    const run = this.getRun(job_id);
    if (run === null) {
      if (Object.keys(this.getJobState(job_id)).length === 0) return false;
      const tx = this.db.transaction(() => {
        this.db.query("DELETE FROM events WHERE job_id = ?").run(job_id);
        this.db.query("DELETE FROM job_state WHERE job_id = ?").run(job_id);
        this.db.query("DELETE FROM run_changes WHERE job_id = ?").run(job_id);
        this.db.query("DELETE FROM run_observations WHERE job_id = ?").run(job_id);
      });
      tx();
      return true;
    }
    const tx = this.db.transaction(() => {
      for (const table of [
        "test_errors",
        "test_metrics",
        "test_results",
        "events",
        "job_state",
        "run_changes",
        "run_observations",
        "runs",
      ]) {
        this.db.query(`DELETE FROM ${table} WHERE job_id = ?`).run(job_id);
      }
    });
    tx();
    return true;
  }

  /** Complete results payload for a job, or null if not found. */
  getFullResults(job_id: string): FullResults | null {
    const run = this.getRun(job_id);
    if (run === null) return null;
    // Fetch metrics once and feed both the per-case join and the flat list
    // (previously test_metrics was read twice).
    const metrics = this.getMetrics(job_id);
    return {
      run,
      results: this.buildResults(job_id, metrics),
      metrics,
      errors: this.getErrors(job_id),
    };
  }
}
