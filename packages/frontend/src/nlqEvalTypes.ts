/**
 * TypeScript types for NLQ Evaluator (BYOLLM) results.
 *
 * These mirror the response shape from GET /nlq-eval/results/<job_id>
 * and the SSE row events from GET /nlq-eval/events/<job_id>.
 *
 * Data flows:
 *   Backend SQLite -> GET /nlq-eval/results -> NlqEvalFullResults
 *   Backend Redis Pub/Sub -> SSE /nlq-eval/events -> NlqEvalRowPayload
 *   Both paths are normalized into NlqEvalTableRow for the results table.
 */

/** Top-level metadata for an NLQ eval job (persisted in SQLite `nlq_runs` table). */
export interface NlqEvalRun {
  job_id: string;
  org_id: string;
  user_id: string;
  /** AI feature being tested (e.g. "viz-authoring", "calc", "prep"). */
  ai_feature: string;
  /** Runner used for this job (e.g. "ect-server", "calc-prompt"). */
  runner_name: string;
  /** Original POST /nlq-eval/run payload, stored for provenance. */
  config: Record<string, any>;
  status: "queued" | "started" | "paused" | "finished" | "failed" | "cancelled";
  /** Total number of test cases to evaluate. */
  total: number;
  /** Number of test cases completed so far. */
  completed: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** A single test case result row (persisted in SQLite `nlq_results` table). */
export interface NlqEvalTestResult {
  id: number;
  job_id: string;
  /** Unique identifier for the test case (usually filename stem). */
  test_case_id: string;
  runner: string;
  datasource: string | null;
  /** The natural language query being tested. */
  utterance: string;
  /** Ground-truth output from the test case definition. */
  expected: NlqEvalOutput | null;
  /** LLM-generated output from the runner. */
  actual: NlqEvalOutput | null;
  /** End-to-end latency in seconds. */
  latency: number | null;
  /** Runner-specific debug data (e.g. raw LLM response, prompt tokens). */
  debug_info: Record<string, any> | null;
  /** Additional info attached by the runner (e.g. step metadata). */
  info: Record<string, any> | null;
  created_at: string;
}

/**
 * The expected/actual output from NLQ eval runners.
 * Shape varies by runner type: viz-authoring runners produce notionalSpec,
 * calc runners produce calculation, etc. Indexed signature allows
 * runner-specific fields to pass through.
 */
export interface NlqEvalOutput {
  /** Detected user intent (e.g. "create-viz", "create-calc"). */
  intent?: string;
  /** Notional spec for viz-authoring runners (Tableau's internal viz spec format). */
  notionalSpec?: {
    version: string;
    fields: Array<{
      caption: string;
      type?: string;
      role?: string;
      data?: string;
      encoding?: string;
      aggregation?: string;
      _tb_wildcards?: string[];
    }>;
    chart?: string;
    relativeDateFilters?: any[];
    dateRangeFilters?: any[];
    rangeFilters?: any[];
    categoricalFilters?: any[];
    sort?: any;
  } | null;
  /** For calc runners */
  calculation?: string;
  /** For other runner types */
  [key: string]: any;
}

/** A single metric score for one test case (persisted in SQLite `nlq_metrics` table). */
export interface NlqEvalMetric {
  id: number;
  job_id: string;
  test_case_id: string;
  /** Evaluation stage the metric applies to (e.g. "intent", "notionalSpec"). */
  stage: string;
  metric_id: string | null;
  /** Metric name (e.g. "equals", "precision", "recall", "fieldValidity"). */
  metric_name: string;
  /** Metric score, typically 0.0-1.0. Null if metric could not be computed. */
  score: number | null;
  explanation: string | null;
}

/** An error or warning recorded during test case evaluation (SQLite `nlq_errors` table). */
export interface NlqEvalError {
  id: number;
  job_id: string;
  test_case_id: string;
  /** Pipeline phase where the error occurred (e.g. "runner", "metric", "parse"). */
  phase: string;
  description: string | null;
  /** 1 = warning, 0 = error. Stored as integer for SQLite compatibility. */
  is_warning: number;
}

/** Full response from GET /nlq-eval/results/<job_id> */
export interface NlqEvalFullResults {
  run: NlqEvalRun;
  results: NlqEvalTestResult[];
  metrics: NlqEvalMetric[];
  errors: NlqEvalError[];
  /** Live run-state blob (progress + the judge identity stamped at run
   *  start). Null once the state has been reaped. */
  state?: Record<string, any> | null;
}

/**
 * Streamed row event payload from SSE (type="row").
 * Emitted by the backend once per completed test case during a running job.
 * Metrics are grouped by stage (e.g. "intent", "notionalSpec") unlike the
 * flat list in the SQLite-backed NlqEvalMetric[].
 */
export interface NlqEvalRowPayload {
  test_case_id: string;
  runner: string;
  datasource: string | null;
  utterance: string;
  /** Conversation turn index (0-based). Always 0 for single-turn runners. */
  turn: number;
  expected: NlqEvalOutput | null;
  actual: NlqEvalOutput | null;
  /** End-to-end latency in seconds. */
  latency: number | null;
  errors: Array<{ phase: string; description: string; warning?: boolean }>;
  /** Metrics grouped by stage name -> list of metric results. */
  metrics: Record<string, Array<{
    metric_id: string;
    metric_name: string;
    score: number | null;
    explanation: string | null;
  }>>;
  debug_info: Record<string, any> | null;
  info: Record<string, any> | null;
}

/**
 * Enriched row for the Ant Design results table.
 * Created by joining test results + metrics + errors (from SQLite)
 * or by transforming a streamed NlqEvalRowPayload (from SSE).
 * Metric scores are flattened to top-level fields for easy column binding.
 */
export interface NlqEvalTableRow {
  /** React key, set to test_case_id. */
  key: string;
  test_case_id: string;
  runner: string;
  datasource: string | null;
  utterance: string;
  expected: NlqEvalOutput | null;
  actual: NlqEvalOutput | null;
  /** End-to-end latency in seconds. */
  latency: number | null;
  /** Full stage-grouped metrics (all stages incl. vizQuality/llmJudge/
   *  calculatedFieldFormula) — the source for bucket/judge rendering.
   *  The flattened fields below remain for column binding. */
  metricsByStage: Record<string, Array<{
    metric_id?: string | null;
    metric_name: string;
    score: number | null;
    explanation?: string | null;
  }>>;
  /** True for a skeleton row announced up-front and not yet executed. */
  pending?: boolean;
  /** A pending row the run is working on right now; the other pending rows
   *  are still waiting their turn. */
  running?: boolean;
  /** A pending row whose first attempt the server did not answer: the run
   *  is asking again at the end of the suite. */
  retrying?: boolean;
  /** Intent stage "equals" metric (1.0 = match, 0.0 = mismatch). */
  intentEquals: number | null;
  /** NotionalSpec stage "equals" metric (exact match). */
  specEquals: number | null;
  /** NotionalSpec stage "precision" metric (correct fields / generated fields). */
  specPrecision: number | null;
  /** NotionalSpec stage "recall" metric (correct fields / expected fields). */
  specRecall: number | null;
  /** NotionalSpec stage "fieldValidity" metric (valid field references). */
  specFieldValidity: number | null;
  errors: Array<{ phase: string; description: string | null; is_warning: boolean }>;
  debug_info: Record<string, any> | null;
  info: Record<string, any> | null;
}

/**
 * Aggregate metrics across all test cases, displayed in the summary cards
 * at the top of the NlqResultsPage. Averages are computed over non-null
 * values only (test cases where a metric could not be computed are excluded).
 */
export interface NlqEvalAggregateMetrics {
  totalCases: number;
  completedCases: number;
  avgIntentEquals: number | null;
  avgSpecEquals: number | null;
  avgPrecision: number | null;
  avgRecall: number | null;
  avgFieldValidity: number | null;
  /** Average latency in seconds. */
  avgLatency: number | null;
  /** Number of test cases that had at least one error (warnings excluded). */
  errorCount: number;
  /** Number of test cases whose only problems were warnings. */
  warningCount: number;
}
