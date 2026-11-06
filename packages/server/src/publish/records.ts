/**
 * One record model for everything that leaves the tool: the CSV and JSON
 * exports and the datasource published to Tableau Server (schema version 3).
 *
 * An admin reads these in two ways: one run on its own ("what did I test,
 * against what, and how did it do?") and many runs together, months apart,
 * often by someone who never opened the tool. Every row therefore carries the
 * run's whole identity. A row is about ONE test case: run-level averages and
 * totals are not columns (Tableau aggregates the case and metric rows itself);
 * the JSON export carries them once, in `summary`.
 *
 * Three renderings, one column list:
 *   - `RUN_COLUMNS`    — the run, denormalized onto every row;
 *   - `CASE_COLUMNS`   — one test case;
 *   - `METRIC_COLUMNS` — one metric of one case (the published table is
 *     long-form, one row per case × metric; the CSV is wide, one column per
 *     metric; the JSON nests the metrics under each case).
 *
 * The published table is APPEND-FOREVER: its columns can never change without
 * a new `SCHEMA_VERSION` (also the publish tag). Scores derive from the metric
 * catalog (`metricCatalog` in `@tableau-ai-eval/core`) — the same categories, weights
 * and rules as the results page.
 *
 * Rendering conventions:
 *   - Split like the rest of `publish/`: `buildRunBundleFromData` is the pure
 *     reshape of an already-fetched `{run, metrics, errors, results}` + job
 *     state; callers own the DB reads.
 *   - Python's `datetime` values are JS `Date`s here; `formatTimestamp`
 *     reproduces `strftime("%Y-%m-%dT%H:%M:%SZ")`.
 *   - `pyJson`/`pyFloat` reproduce Python's `json.dumps(…, separators=(",",
 *     ":"))` (ensure_ascii) and float `repr`, so CSV/Hyper text cells match
 *     the Python bytes (1.0 renders "1.0", not "1").
 */

import { metricCatalog as mc } from "@tableau-ai-eval/core";
import type { CatalogBucket, FullResults, JobState, MetricRow } from "@tableau-ai-eval/core";
import { NO_EXPECTED_CHART_WARNING } from "@tableau-ai-eval/evals";
import { displayLabel } from "../suites/catalog.ts";

export const SCHEMA_VERSION = 3;

export type ColumnType = "text" | "int" | "double" | "bool" | "timestamp" | "json";
export type Column = readonly [name: string, type: ColumnType];

// `json` renders as compact JSON text in the CSV and the datasource and as an
// object in the JSON export; `timestamp` is ISO 8601 UTC text in the CSV/JSON
// and a TIMESTAMP_TZ in the datasource.
export const RUN_COLUMNS: readonly Column[] = [
  ["schema_version", "int"],
  ["run_id", "text"],
  ["tool_version", "text"],
  ["run_status", "text"],
  ["run_started_at", "timestamp"],
  ["run_finished_at", "timestamp"],
  ["run_duration_s", "double"],
  ["exported_at", "timestamp"],
  ["tableau_server_url", "text"],
  ["tableau_site", "text"],
  ["tableau_site_luid", "text"],
  ["tableau_server_version", "text"],
  ["capability", "text"],
  ["capability_label", "text"],
  ["suite_case_count", "int"],
  ["model_under_test", "text"],
  ["model_provider", "text"],
  ["answered_by", "text"],
  ["judge_provider", "text"],
  ["judge_model", "text"],
];

export const CASE_COLUMNS: readonly Column[] = [
  ["case_number", "int"],
  ["test_case_id", "text"],
  ["datasource", "text"],
  ["utterance", "text"],
  ["expected_kind", "text"],
  ["expected", "json"],
  ["actual", "json"],
  ["latency_s", "double"],
  ["case_status", "text"],
  ["case_score", "double"],
  ["case_verdict", "text"],
  ["error_count", "int"],
  ["warning_count", "int"],
  ["errors_text", "text"],
  ["case_tags", "text"],
];

export const METRIC_COLUMNS: readonly Column[] = [
  ["metric_stage", "text"],
  ["metric_name", "text"],
  ["metric_id", "text"],
  ["metric_label", "text"],
  ["metric_category", "text"],
  ["metric_category_weight", "int"],
  ["score", "double"],
  ["judge_derived", "bool"],
  ["unavailable", "bool"],
  ["explanation", "text"],
];

/** What each column means — the JSON export's dictionary and the docs. */
export const COLUMN_MEANINGS: Record<string, string> = {
  schema_version: "Version of this column set. Rows with different versions are not in the same table.",
  run_id: "The run's identifier. Every row of one run carries the same value; filter on it to see one run.",
  tool_version: "Version of the evaluation tool that produced the run.",
  run_status: "How the run ended: Completed, Paused, Canceled, or Failed; In progress or Queued for a run exported before it ended.",
  run_started_at: "When the run was launched (UTC).",
  run_finished_at: "When the run ended (UTC); empty while it is still going or paused.",
  run_duration_s: "Seconds from launch to end; empty until the run has ended.",
  exported_at: "When this file or publish was produced (UTC).",
  tableau_server_url: "The Tableau Server whose AI settings were under test.",
  tableau_site: "The site under test (its name in the URL; Default for the default site).",
  tableau_site_luid: "The site's identifier on the server.",
  tableau_server_version: "The server's product version and build at the time of the run, as the server reports them: 2026.1.0 (20261.26.0415.1010).",
  capability: "The AI capability the suite exercises (calc, viz-authoring, palettes, ...).",
  capability_label: "The capability as the site settings name it (Calculated fields, Build a visualization, ...).",
  suite_case_count: "How many cases the suite has. A run with fewer rows than this (count the distinct test_case_id values) is partial.",
  model_under_test: "The model that answered: the model the site had configured, read from Site Settings when the run started.",
  model_provider: "The provider configured for the model, when the site settings say.",
  answered_by: "The address the tool sent the questions to: the Tableau Server endpoint that passes them to the site's model.",
  judge_provider: "Provider of the LLM judge that scored the natural-language metrics; empty when no judge ran.",
  judge_model: "The judge model; empty when no judge ran.",
  case_number: "Position of the case in the run.",
  test_case_id: "The case's identifier in the suite; stable across runs of the suite.",
  datasource: "The data source the case asks about.",
  utterance: "The question or request sent to the AI feature.",
  expected_kind: "What the case expects back: formula, viz_spec, plan, palette, narrative, reply or intent.",
  expected: "The known-good answer, as JSON.",
  actual: "What the model produced, as JSON; empty when the case errored.",
  latency_s: "Seconds the server took to answer this case.",
  case_status: "scored (has a score), error (no score, hit an error), unavailable (only judge scores, all failed), or unscored (nothing to score, or the suite gives no expected answer for the case).",
  case_score: "The case's overall score, 0 to 1: its category averages weighted by the category weights (metric_category_weight).",
  case_verdict: "pass, partial or fail on case_score (provisional bands: pass at 0.66 and above, partial at 0.33 and above); na without a score.",
  error_count: "Errors this case hit.",
  warning_count: "Warnings this case raised (not errors).",
  errors_text: "The error messages, separated by ' | '.",
  case_tags: "Reserved for case labels (intent, operation, output type); empty for now.",
  metric_stage: "The metric's stage in the evaluator (llmJudge = judge-scored).",
  metric_name: "The metric's name in the evaluator.",
  metric_id: "The evaluator's identifier for the metric implementation.",
  metric_label: "The metric's display name, as the results page shows it.",
  metric_category: "The category the metric rolls up into (Calculated Fields, Data, Design, ...).",
  metric_category_weight: "The category's weight in the overall score; 0 for natural-language categories.",
  score: "The metric's score, 0 to 1; empty when the judge could not score the case (see unavailable).",
  judge_derived: "True when an LLM judge produced the score.",
  unavailable: "True when a judge metric exists for the case but the judge call failed (score empty).",
  explanation: "The scorer's explanation of the score, when it gave one.",
};

const STATUS_LABELS: Record<string, string> = {
  finished: "Completed",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Canceled",
  queued: "Queued",
  started: "In progress",
  running: "In progress",
};

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SQLite's `datetime('now')` text ('YYYY-MM-DD HH:MM:SS', UTC) or an ISO 8601
 * string, to a Date; null for nothing/unparseable. A naive time is UTC.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim().replace(" ", "T");
  if (s.endsWith("Z")) s = `${s.slice(0, -1)}+00:00`;
  // Naive (no offset after the time part) → UTC, as Python does.
  if (!/[+-]\d{2}:?\d{2}$/.test(s.slice(10))) s += "+00:00";
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** `strftime("%Y-%m-%dT%H:%M:%SZ")` — whole seconds, UTC; "" for null. */
export function formatTimestamp(d: Date | null | undefined): string {
  return d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : "";
}

/**
 * What a case expects back, from the shape of its expected answer.
 *
 * Every runner's shape is listed, so the column reads the same way for every
 * capability: Tableau Agent's calculations (`calculatedFieldFormula`) and
 * Tableau Prep's (`calculation`) are both a formula; a multi-step plan
 * (`steps`) and a Prep flow plan (`flowPlan`) are both a plan.
 */
export function expectedKind(expected: unknown): string {
  if (expected === null || expected === undefined) return "";
  if (typeof expected === "string") return "reply";
  if (typeof expected !== "object" || Array.isArray(expected)) return "other";
  const keys = new Set(Object.keys(expected));
  if (keys.has("calculatedFieldFormula") || keys.has("calculation")) return "formula";
  if (keys.has("notionalSpec") || keys.has("spec")) return "viz_spec";
  if (keys.has("steps") || keys.has("flowPlan")) return "plan";
  if (keys.has("colorPalette")) return "palette";
  if (keys.has("narrative") || keys.has("insightNarrative")) return "narrative";
  if (keys.has("user_friendly_reply") || keys.has("output_types")) return "reply";
  // Last: calc and viz cases carry an intent beside their answer.
  if (keys.has("intent")) return "intent";
  return "other";
}

type Cfg = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * The model that answered: the model Site Settings held at launch; on a
 * developer run against a gateway, the explicit override; failing both, what
 * the admin declared.
 */
function modelUnderTest(cfg: Cfg): string {
  const models = (cfg.models as Cfg) || {};
  return s(
    models.create ||
      models.understand ||
      cfg.resolved_site_model ||
      cfg.declared_site_model ||
      "",
  );
}

function usesTableauPath(cfg: Cfg): boolean {
  const adapter = s(cfg.adapter).toLowerCase();
  return (
    adapter === "cabu" ||
    adapter === "palettes" ||
    s(cfg.generations_mode).toLowerCase() === "ces"
  );
}

/**
 * The service the questions went to. Never the embedded bridge's loopback
 * address (runs before schema 2 stored it as gateway_url).
 */
function answeredBy(cfg: Cfg, tableauPath: boolean): string {
  const server = s(cfg.tableau_server_url || cfg.tableau_server).replace(/\/+$/, "");
  const adapter = s(cfg.adapter).toLowerCase();
  if (adapter === "cabu") return server;
  if (adapter === "palettes" || s(cfg.generations_mode).toLowerCase() === "ces") {
    const ces = s(cfg.ces_url).trim();
    if (ces && !LOOPBACK.test(ces)) return ces;
    return server ? `${server}/content-exploration` : "";
  }
  const gateway = s(cfg.gateway_url);
  if (tableauPath && LOOPBACK.test(gateway)) return server;
  return gateway;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface MetricRecord {
  metric_stage: string;
  metric_name: string;
  metric_id: string;
  metric_label: string;
  metric_category: string;
  metric_category_weight: number;
  score: number | null;
  judge_derived: boolean;
  unavailable: boolean;
  explanation: string;
}

export interface CaseRecord {
  case_number: number;
  test_case_id: string;
  datasource: string;
  utterance: string;
  expected_kind: string;
  expected: unknown;
  actual: unknown;
  latency_s: number | null;
  case_status: "scored" | "error" | "unavailable" | "unscored";
  case_score: number | null;
  case_verdict: mc.Verdict;
  error_count: number;
  warning_count: number;
  errors_text: string;
  case_tags: string;
  metrics: MetricRecord[];
  [key: string]: unknown;
}

export interface SummaryMetric {
  metric: string;
  label: string;
  category: string;
  average: number | null;
  scored_cases: number;
  unavailable_cases: number;
  judge_derived: boolean;
}

export interface SummaryCategory {
  key: string;
  label: string;
  weight: number;
  average: number | null;
  metrics: Array<{ label: string; average: number | null; judge_derived: boolean }>;
}

export interface RunSummary {
  viz_quality_score: number | null;
  nl_quality_score: number | null;
  /** The capability's own averages, never one blended number. */
  headline_scores: mc.HeadlineScore[];
  categories: SummaryCategory[];
  verdicts: Record<mc.Verdict, number>;
  verdict_thresholds: mc.VerdictThresholds;
  cases_total: number;
  cases_completed: number;
  cases_scored: number;
  cases_with_errors: number;
  avg_latency_s: number | null;
  metrics: SummaryMetric[];
}

export type MetricDictionaryEntry = Omit<mc.MetricDescription, "category_key">;

export interface RunBundle {
  /** The run columns (timestamps as Date) plus JSON-only extras. */
  run: Record<string, unknown>;
  cases: CaseRecord[];
  summary: RunSummary;
  metric_dictionary: Record<string, MetricDictionaryEntry>;
}

/**
 * Everything about one run, ready to render (the DB/state read is the caller's).
 */
export function buildRunBundleFromData(
  jobId: string,
  data: FullResults,
  st: JobState,
  now: () => Date = () => new Date(),
): RunBundle {
  const run = data.run;
  const cfg: Cfg = run.config && typeof run.config === "object" ? run.config : {};

  // ---- metrics and errors per case ----
  const metricsByCase = new Map<string, MetricRow[]>();
  for (const m of data.metrics) {
    const l = metricsByCase.get(m.test_case_id) ?? [];
    metricsByCase.set(m.test_case_id, l);
    l.push(m);
  }
  const errorsByCase = new Map<string, FullResults["errors"]>();
  for (const e of data.errors) {
    const l = errorsByCase.get(e.test_case_id) ?? [];
    errorsByCase.set(e.test_case_id, l);
    l.push(e);
  }

  // ---- cases ----
  const cases: CaseRecord[] = [];
  const stageMaps: mc.StageMetrics[] = [];
  data.results.forEach((r, idx) => {
    const tc = r.test_case_id;
    const rows = metricsByCase.get(tc) ?? [];
    const all = errorsByCase.get(tc) ?? [];
    const errs = all.filter((e) => !e.is_warning);
    const warns = all.filter((e) => !!e.is_warning);
    const sm = mc.stageMap(rows);
    stageMaps.push(sm);
    let caseScore = mc.weightedOverall(mc.computeRowBuckets(sm));
    const scored = rows.some((m) => m.score !== null && m.score !== undefined);
    // A chart case the suite ships without an expected chart: the answer was
    // not scored, so the case has no score and no verdict, whatever its
    // request-type and judge metrics say.
    const noExpectedAnswer = warns.some((w) => w.description === NO_EXPECTED_CHART_WARNING);
    if (noExpectedAnswer) caseScore = null;
    const status: CaseRecord["case_status"] = noExpectedAnswer
      ? "unscored"
      : scored
        ? "scored"
        : errs.length
          ? "error"
          : rows.length
            ? "unavailable"
            : "unscored";
    const metrics: MetricRecord[] = rows.map((m) => {
      const info = mc.describeMetric(m.stage, m.metric_name);
      const score = m.score ?? null;
      return {
        metric_stage: m.stage,
        metric_name: m.metric_name,
        metric_id: m.metric_id || "",
        metric_label: info.label,
        metric_category: info.category,
        metric_category_weight: info.category_weight,
        score,
        judge_derived: info.judge_derived,
        unavailable: score === null,
        explanation: m.explanation || "",
      };
    });
    cases.push({
      case_number: idx + 1,
      test_case_id: tc,
      datasource: r.datasource || "",
      utterance: r.utterance || "",
      expected_kind: expectedKind(r.expected),
      expected: r.expected ?? null,
      actual: r.actual ?? null,
      latency_s: r.latency !== null && r.latency !== undefined ? Number(r.latency) : null,
      case_status: status,
      case_score: caseScore,
      case_verdict: mc.verdict(caseScore),
      error_count: errs.length,
      warning_count: warns.length,
      errors_text: errs.map((e) => e.description || e.phase || "error").join(" | "),
      case_tags: "",
      metrics,
    });
  });

  // ---- run-level scores ----
  const aggregate = mc.computeAggregateBuckets(stageMaps);
  const cards = mc.cardScores(aggregate);
  const verdicts: Record<mc.Verdict, number> = { pass: 0, partial: 0, fail: 0, na: 0 };
  for (const c of cases) verdicts[c.case_verdict] += 1;
  const latencies = cases.map((c) => c.latency_s).filter((v): v is number => v !== null);

  // ---- run identity ----
  const started = parseTimestamp(run.created_at);
  const finished = parseTimestamp(run.finished_at);
  const statusKey = s(st.status || run.status).toLowerCase();
  const tableauPath = usesTableauPath(cfg);
  const model = modelUnderTest(cfg);
  const capability = s(run.ai_feature || cfg.ai_feature);
  const serverUrl = tableauPath
    ? s(cfg.tableau_server_url || cfg.tableau_server).replace(/\/+$/, "")
    : "";
  const siteName =
    s(cfg.tableau_site_name) ||
    (tableauPath ? s(cfg.tableau_site).trim() || "Default" : "");
  const total = (st.total as number) || (run.total as number) || cases.length;
  const runCasesScored = cases.filter((c) => c.case_status === "scored").length;
  const runCasesWithErrors = cases.filter((c) => c.error_count).length;
  const avgLatency = mean(latencies);

  const runRecord: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    run_id: jobId,
    tool_version: s(cfg.tool_version),
    run_status:
      STATUS_LABELS[statusKey] ??
      (statusKey ? statusKey[0].toUpperCase() + statusKey.slice(1) : ""),
    run_started_at: started,
    run_finished_at: finished,
    run_duration_s:
      started && finished ? (finished.getTime() - started.getTime()) / 1000 : null,
    exported_at: now(),
    tableau_server_url: serverUrl,
    tableau_site: siteName,
    tableau_site_luid: s(cfg.tableau_site_luid),
    tableau_server_version: s(cfg.tableau_server_version),
    capability,
    capability_label: mc.capabilityLabel(capability),
    suite_case_count: total,
    model_under_test: model,
    model_provider: s(cfg.site_model_provider || cfg.model_provider),
    answered_by: answeredBy(cfg, tableauPath),
    judge_provider: s(st.judge_provider),
    judge_model: s(st.judge_model),
  };

  // JSON-only extras: the suite's name, the raw model slots and where the
  // suite lived on this machine. None of these is a column: the table says
  // what was tested in as few columns as it can (capability + case count
  // identify the suite).
  const suiteId = s(cfg.suite_id || st.suite_id);
  const runExtras = {
    suite_id: suiteId,
    // The suite's CURRENT catalog name (suites were renamed after the
    // capability chips); the stored label for unknown ids.
    suite_label: s(displayLabel(suiteId, cfg.suite_label || st.suite_label)),
    models: (cfg.models as Cfg) || {},
    declared_site_model: s(cfg.declared_site_model),
    resolved_site_model: s(cfg.resolved_site_model),
    batch_id: s(cfg.batch_id),
    local: {
      test_path: s(cfg.test_path || cfg.test_cases_dir || cfg.test_data_id),
      runner: s(run.runner_name || cfg.runner),
    },
  };

  // ---- summary ----
  const perMetric = new Map<
    string,
    {
      label: string;
      category: string;
      judge_derived: boolean;
      scores: number[];
      unavailable_cases: number;
    }
  >();
  for (const c of cases) {
    for (const m of c.metrics) {
      const key = `${m.metric_stage}.${m.metric_name}`;
      let e = perMetric.get(key);
      if (!e) {
        e = {
          label: m.metric_label,
          category: m.metric_category,
          judge_derived: m.judge_derived,
          scores: [],
          unavailable_cases: 0,
        };
        perMetric.set(key, e);
      }
      if (m.score === null) e.unavailable_cases += 1;
      else e.scores.push(Number(m.score));
    }
  }
  const sortedKeys = [...perMetric.keys()].sort();
  const summaryMetrics: SummaryMetric[] = sortedKeys.map((key) => {
    const e = perMetric.get(key)!;
    return {
      metric: key,
      label: e.label,
      category: e.category,
      average: mean(e.scores),
      scored_cases: e.scores.length,
      unavailable_cases: e.unavailable_cases,
      judge_derived: e.judge_derived,
    };
  });
  const summaryCategories: SummaryCategory[] = aggregate.map((b: CatalogBucket) => ({
    key: b.def.key,
    label: mc.categoryLabel(b.def.key, capability),
    weight: b.def.weight,
    average: b.avg,
    metrics: b.items.map((i) => ({ label: i.label, average: i.value, judge_derived: i.judge })),
  }));
  const summary: RunSummary = {
    viz_quality_score: cards.viz ?? null,
    nl_quality_score: cards.nl ?? null,
    headline_scores: mc.headlineScores(aggregate, capability),
    categories: summaryCategories,
    verdicts,
    verdict_thresholds: mc.thresholds(),
    cases_total: total,
    cases_completed: cases.length,
    cases_scored: runCasesScored,
    cases_with_errors: runCasesWithErrors,
    avg_latency_s: avgLatency,
    metrics: summaryMetrics,
  };

  const metricDictionary: Record<string, MetricDictionaryEntry> = {};
  for (const key of sortedKeys) {
    const dot = key.indexOf(".");
    const { category_key: _k, ...rest } = mc.describeMetric(key.slice(0, dot), key.slice(dot + 1));
    metricDictionary[key] = rest;
  }

  return {
    run: { ...runRecord, ...runExtras },
    cases,
    summary,
    metric_dictionary: metricDictionary,
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers shared by the CSV and the datasource
// ---------------------------------------------------------------------------

/** Python float `repr` (shortest round-trip; `1.0`, `1e-05`, `1e+16`). */
export function pyFloat(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, expStr] = x.toExponential().split("e");
  const exp = Number(expStr);
  if (exp < -4 || exp >= 16) {
    const sign = exp < 0 ? "-" : "+";
    return `${mant}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const fixed = String(x);
  return /[.e]/.test(fixed) ? fixed : `${fixed}.0`;
}

/** Python `json.dumps(v, separators=(",", ":"))` (ensure_ascii, float repr). */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    // JSON has lost int-vs-float by here; integral numbers render as ints.
    return Number.isInteger(value) && Math.abs(value) < 1e16 ? String(value) : pyFloat(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (Array.isArray(value)) return `[${value.map(pyJson).join(",")}]`;
  if (value instanceof Date) return pyJson(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  return `{${entries.map(([k, v]) => `${pyJson(k)}:${pyJson(v)}`).join(",")}}`;
}

/** A column value as CSV text (null → empty). */
export function renderText(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "timestamp":
      return formatTimestamp(parseTimestamp(value));
    case "json":
      return pyJson(value);
    case "bool":
      return value ? "true" : "false";
    case "double":
      return typeof value === "number" ? pyFloat(value) : String(value);
    default:
      return String(value);
  }
}

/** A column value for the JSON export (timestamps as ISO text). */
export function renderJson(value: unknown, type: ColumnType): unknown {
  if (type === "timestamp") return formatTimestamp(parseTimestamp(value)) || null;
  return value;
}

/** `ai-model-eval_<suite>_<model>_<date>_<run id prefix>`. */
export function filenameStem(run: Record<string, unknown>): string {
  const clean = (v: unknown, fallback: string): string => {
    const out = s(v)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return out || fallback;
  };
  const started = parseTimestamp(run.run_started_at);
  const date = started ? started.toISOString().slice(0, 10) : "undated";
  return [
    "ai-model-eval",
    clean(run.suite_id || run.capability, "suite"),
    clean(run.model_under_test, "model-unknown"),
    date,
    s(run.run_id).slice(0, 8),
  ].join("_");
}
