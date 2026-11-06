/**
 * SQLite schema for the NLQ Evaluator. Seven legacy tables:
 *   runs, test_results, test_metrics, test_errors, job_state, events, settings
 * plus the four indexes. WAL mode is set by the DB opener (see index.ts),
 * with `PRAGMA journal_mode=WAL`.
 *
 * Legacy tables retain their existing schema. Native observation tables are
 * additive; existing databases acquire them through CREATE IF NOT EXISTS.
 *
 * DEFERRED PERF (T3.5): the result/metric/error read paths query
 * `WHERE job_id=? ORDER BY id`, but idx_test_results_job / idx_test_metrics_job
 * / idx_test_errors_job are single-column `(job_id)` only, so SQLite sorts by
 * `id` per request. Making them composite `(job_id, id)` (like idx_events_job)
 * would let the index satisfy the ORDER BY. Left as-is to preserve the
 * existing schema above; change these to composite (and optionally add
 * `idx_runs_created(created_at)` for listRuns) WHEN it is acceptable to diverge
 * from the existing schema. Note: renaming/altering an existing index name is a
 * no-op under `IF NOT EXISTS`, so an actual migration would need drop+recreate.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    job_id       TEXT PRIMARY KEY,
    org_id       TEXT,
    user_id      TEXT,
    ai_feature   TEXT,
    runner_name  TEXT,
    config       TEXT,     -- full incoming JSON config
    status       TEXT DEFAULT 'queued',
    total        INTEGER DEFAULT 0,
    completed    INTEGER DEFAULT 0,
    error        TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS test_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES runs(job_id),
    test_case_id TEXT NOT NULL,
    runner       TEXT,
    datasource   TEXT,
    utterance    TEXT,
    expected     TEXT,       -- JSON
    actual       TEXT,       -- JSON
    latency      REAL,
    debug_info   TEXT,       -- JSON
    info         TEXT,       -- JSON
    created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_metrics (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES runs(job_id),
    test_case_id TEXT NOT NULL,
    stage        TEXT NOT NULL,
    metric_id    TEXT,
    metric_name  TEXT NOT NULL,
    score        REAL,
    explanation  TEXT
);

CREATE TABLE IF NOT EXISTS test_errors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES runs(job_id),
    test_case_id TEXT NOT NULL,
    phase        TEXT NOT NULL,
    description  TEXT,
    is_warning   INTEGER DEFAULT 0
);

-- Single-process tables. These replace the Redis job-state
-- blob, cancel flag, and SSE replay caches; \`settings\` backs the judge
-- configuration.

CREATE TABLE IF NOT EXISTS job_state (
    job_id     TEXT PRIMARY KEY,
    state      TEXT NOT NULL DEFAULT '{}',  -- JSON blob, merge-patched
    control    TEXT,                        -- NULL | 'cancel' | 'pause'
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- global monotonic seq
    job_id     TEXT NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,   -- compact JSON, exactly the streamed line
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,   -- JSON
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_test_results_job ON test_results(job_id);
CREATE INDEX IF NOT EXISTS idx_test_metrics_job ON test_metrics(job_id);
CREATE INDEX IF NOT EXISTS idx_test_errors_job  ON test_errors(job_id);
CREATE INDEX IF NOT EXISTS idx_events_job       ON events(job_id, id);

-- Native observation protocol: current metadata/definitions, not event sourcing.
CREATE TABLE IF NOT EXISTS run_observations (
    job_id TEXT PRIMARY KEY REFERENCES runs(job_id),
    projection TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(job_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_run_changes_job ON run_changes(job_id, revision);
`;
