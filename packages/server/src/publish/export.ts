/**
 * Server-side result exports —
 * CSV and JSON rendering from the common record model.
 *
 * Both exports render the run bundle from `records.ts`
 * (`buildRunBundleFromData`):
 *
 * - JSON: `{schema_version, run, summary, cases, metric_dictionary,
 *   column_dictionary}` — the run's identity and headline numbers, every
 *   category and metric average, each case with its metrics (label and
 *   category attached), and dictionaries explaining every metric and column,
 *   so the file stands on its own.
 * - CSV: one row per case. The run columns are repeated on every row, then
 *   the case columns, then one column per metric (`stage.metric_name`, so
 *   `llmJudge.*` columns are visibly judge-derived). The run and case columns
 *   are exactly the published datasource's, in the same order.
 *
 * Secrets never appear: runs.config is redacted at rest and only
 * named, non-secret fields are selected into the run record.
 *
 * `buildExportFromData(jobId, data, state)` is the pure reshape;
 * the route does the DB/state read.
 */

import type { FullResults, JobState } from "@tableau-ai-eval/core";
import {
  CASE_COLUMNS,
  COLUMN_MEANINGS,
  RUN_COLUMNS,
  SCHEMA_VERSION,
  buildRunBundleFromData,
  filenameStem as recordsFilenameStem,
  pyFloat,
  renderJson,
  renderText,
  type CaseRecord,
  type MetricDictionaryEntry,
  type RunSummary,
} from "./records.ts";

export type {
  MetricRow,
  ErrorRow,
  ResultRow,
  RunRecord,
  FullResults,
  RunState,
} from "@tableau-ai-eval/core";

export const JUDGE_STAGE = "llmJudge";
export const UNAVAILABLE = "Unavailable";

export interface Export {
  schema_version: number;
  /** Run columns (timestamps as ISO text) + JSON-only extras. */
  run: Record<string, unknown>;
  summary: RunSummary;
  cases: CaseRecord[];
  metric_dictionary: Record<string, MetricDictionaryEntry>;
  column_dictionary: Record<string, string>;
}

/** Injectable clock — lets tests pin `exported_at`. */
export type Now = () => Date;

/** The JSON export payload for a run. */
export function buildExportFromData(
  jobId: string,
  data: FullResults,
  st: JobState,
  now: Now = () => new Date(),
): Export {
  const bundle = buildRunBundleFromData(jobId, data, st, now);
  const types = new Map(RUN_COLUMNS.map(([n, t]) => [n, t]));
  const run: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bundle.run)) {
    run[k] = renderJson(v, types.get(k) ?? "text");
  }
  const columnDictionary: Record<string, string> = {};
  for (const [name] of [...RUN_COLUMNS, ...CASE_COLUMNS]) {
    columnDictionary[name] = COLUMN_MEANINGS[name] ?? "";
  }
  return {
    schema_version: SCHEMA_VERSION,
    run,
    summary: bundle.summary,
    cases: bundle.cases,
    metric_dictionary: bundle.metric_dictionary,
    column_dictionary: columnDictionary,
  };
}

/** `ai-model-eval_<suite>_<model>_<date>_<run id prefix>`. */
export function filenameStem(exp: Export): string {
  return recordsFilenameStem(exp.run);
}

/** Run + case columns, then the sorted `stage.metric_name` columns. */
export function csvHeader(exp: Export): string[] {
  const metricCols = new Set<string>();
  for (const c of exp.cases)
    for (const m of c.metrics) metricCols.add(`${m.metric_stage}.${m.metric_name}`);
  return [
    ...RUN_COLUMNS.map(([n]) => n),
    ...CASE_COLUMNS.map(([n]) => n),
    ...[...metricCols].sort(),
  ];
}

/** Python csv.writer QUOTE_MINIMAL field quoting. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Flat CSV (see module docstring). A metric column reads `Unavailable` where
 * a judge metric exists for the case but could not be scored,
 * and is empty where the metric was not computed at all.
 */
export function toCsv(exp: Export): string {
  const header = csvHeader(exp);
  const metricCols = header.slice(RUN_COLUMNS.length + CASE_COLUMNS.length);
  const runValues = RUN_COLUMNS.map(([n, t]) => renderText(exp.run[n], t));
  const lines: string[] = [header.map(csvField).join(",")];
  for (const c of exp.cases) {
    const row = [...runValues, ...CASE_COLUMNS.map(([n, t]) => renderText(c[n], t))];
    const scores = new Map<string, number | null>();
    for (const m of c.metrics) scores.set(`${m.metric_stage}.${m.metric_name}`, m.score);
    for (const col of metricCols) {
      if (!scores.has(col)) row.push("");
      else {
        const v = scores.get(col);
        row.push(v === null || v === undefined ? UNAVAILABLE : pyFloat(Number(v)));
      }
    }
    lines.push(row.map(csvField).join(","));
  }
  // Python csv.writer uses \r\n line terminators.
  return lines.map((l) => `${l}\r\n`).join("");
}
