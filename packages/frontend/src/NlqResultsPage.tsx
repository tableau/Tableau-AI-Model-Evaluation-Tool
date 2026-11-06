/**
 * NlqResultsPage — Interactive results viewer for NLQ Evaluator (BYOLLM) jobs.
 *
 * Loaded at /results/:jobId. Supports:
 * - Live streaming if job is still running (SSE via useNlqEvalStream)
 * - Static results loading if job is finished (from SQLite)
 * - Summary metrics cards (intent match, spec equals, precision, recall, etc.)
 * - Results table with sortable/filterable columns
 * - Expandable row detail: expected vs actual NotionalSpec side-by-side
 * - CSV download
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Alert,
  Card,
  Checkbox,
  Collapse,
  Modal,
  Popconfirm,
  Progress,
  Table,
  Popover,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Button,
  Input,
  Select,
  Space,
  message,
} from './ui';
import type { ColumnsType, ColumnType } from "./ui";
import { BaselineLegend, judgeOnly } from "./headlineScores";
import type { BaselineLookup } from "./headlineScores";
import {
  ArrowLeftOutlined,
  CaretRightOutlined,
  ClockCircleOutlined,
  CollapseAllOutlined,
  ExpandAllOutlined,
  DiffOutlined,
  DownOutlined,
  DownloadOutlined,
  UpOutlined,
  PauseOutlined,
  StopOutlined,
  UploadOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  SearchOutlined,
  SparklesIcon,
} from './ui/icons';
import { VegaLite } from "react-vega";
import type { VisualizationSpec } from "vega-embed";

import { API_BASE } from "./api";
import { useNlqEvalStream, useObservedRunRecords } from "./useNlqEvalStream";
import { EvaluationFeedback } from "./EvaluationFeedback";
import type { NlqEvalRun, NlqEvalTableRow, NlqEvalAggregateMetrics } from "./nlqEvalTypes";
import SpeechBubble from "./SpeechBubble";
import ReplyBubble from "./ReplyBubble";
import {
  FlexCard,
  PRIMARY_COLOR,
  NA_PILL_STYLE,
  SCORE_COLORS,
  SCORE_NA,
  ScorePill,
} from "./components/designSystem";
import { baselineTone, deltaBand } from "./baseline";
import { isDevMode } from "./devMode";
import { DatasetPanel, useDatasets } from "./DatasetPanel";
import { DashboardPanel, DashboardRef, dashboardNameOf } from "./DashboardPanel";
import { ACTIVE_STATUSES, RUNNING_STATUSES, runStatusInfo, isResumableRun } from "./runStatus";
import {
  CATEGORIES, CategoryDef, FeatureKey, categoryOfRun, featureDef, featureOfRun,
} from "./featureGroups";
import { Suite, fetchJudgeReady, httpErrorText, launchSuite } from "./launch";
import { HeadlineScore, RunRecord, publicFullSuite, evaluationHeadlineScores, evaluationStatus } from "./evaluationGroups";
import {
  BucketValue,
  CARD_EXPLAIN,
  METRIC_EXPLAIN,
  QUALITY_CARDS,
  bucketOverall,
  capabilityBaseline,
  categoryLabel,
  computeAggregateBuckets,
  computeRowBuckets,
  relabelBuckets,
} from "./nlqMetricBuckets";
import { TOUR_TARGETS } from "./tour/tourConfig";
import { providerLabel } from "./providers";
import { titleCase } from "./text";
import { generateSyntheticRows, TEMPORAL_AGGS } from "./syntheticChartData.ts";
import { LazyChartPreview } from "./LazyChartPreview.tsx";

const { Text, Paragraph } = Typography;

/** Where Publish to Tableau puts results: the backend's defaults. */
const PUBLISH_DATASOURCE = "AI Model Evaluation Results";
const PUBLISH_PROJECT = "AI Model Evaluations";

// ---------------------------------------------------------------------------
// Synthetic data generation + Vega-Lite preview for notional specs
//
// Notional specs (Tableau's internal viz specification) don't carry real data,
// so we generate synthetic data rows to produce a visual preview using
// Vega-Lite. This gives reviewers a quick visual diff between expected and
// actual specs without needing a live Tableau connection.
// ---------------------------------------------------------------------------

/** Maps Tableau notional spec chart types to Vega-Lite mark types. */
const CHART_TO_MARK: Record<string, string> = {
  bar: "bar",
  line: "line",
  area: "area",
  scatterplot: "point",
  scatter: "point",
  pie: "arc",
  donut: "arc",
  heatmap: "rect",
  treemap: "rect",
  histogram: "bar",
  gantt: "bar",
  text: "text",
  highlight: "bar",
  packedbubble: "circle",
  symbolmap: "circle",
};

/** A notional spec's date part as the Vega-Lite time unit that keeps the
 *  dates in order on the axis ("qtr" is not a Vega-Lite unit: a chart with
 *  it drew nothing). */
const TIME_UNITS: Record<string, string> = {
  year: "year",
  qtr: "yearquarter",
  month: "yearmonth",
  week: "yearweek",
  day: "yearmonthdate",
  hour: "yearmonthdatehours",
};

/**
 * Convert a Tableau notional spec into a Vega-Lite spec for visual preview.
 *
 * Handles single-field, dual-field, and multi-measure (fold transform) layouts.
 * Pie/donut charts are remapped to theta + color encoding.
 *
 * @returns A Vega-Lite spec with synthetic data, or null if the spec has no fields.
 */
/**
 * Reassign notional spec field encodings to proper Vega-Lite x/y channels.
 *
 * Tableau notional specs can have multiple fields on the same shelf (e.g. both
 * "x"), but Vega-Lite needs distinct channels. This function assigns:
 *   - dimension/date fields → x
 *   - measure/number fields → y
 *   - extra fields → color/size
 * If both are the same role, first → x, second → y.
 */
function assignVegaChannels(fields: any[]): any[] {
  // If all encodings are already distinct (x, y, color, etc.), keep them
  const encodings = fields.map((f: any) => f.encoding).filter(Boolean);
  const hasDuplicates = new Set(encodings).size < encodings.length;
  if (!hasDuplicates) return fields;

  // Reassign: dimensions/dates → x, measures → y
  const assigned: any[] = [];
  let xTaken = false, yTaken = false;
  for (const f of fields) {
    const isDim = f.role === "dimension" || f.data === "string" || f.data === "date";
    const isMeasure = f.role === "measure" || f.data === "number";
    let channel = f.encoding || "x";

    if (isDim && !xTaken) { channel = "x"; xTaken = true; }
    else if (isMeasure && !yTaken) { channel = "y"; yTaken = true; }
    else if (!xTaken) { channel = "x"; xTaken = true; }
    else if (!yTaken) { channel = "y"; yTaken = true; }
    else { channel = "color"; }

    assigned.push({ ...f, encoding: channel });
  }
  return assigned;
}

/**
 * How a preview fits its table cell. `width` is the room for the WHOLE
 * chart, axes and legend included: without this the plot alone took the
 * width and the axis and legend were drawn on top of the next column. The
 * legend sits under the plot, where long category names have room.
 */
const PREVIEW_LAYOUT = {
  autosize: { type: "fit-x", contains: "padding" },
  config: {
    view: { stroke: null },
    legend: { orient: "bottom", direction: "horizontal", columns: 3, labelLimit: 64, titleLimit: 220, symbolSize: 60 },
    axis: { labelLimit: 72, titleLimit: 180 },
  },
} as const;

/** The values a categorical filter keeps, by field, so the preview's sample
 *  rows show them: a chart filtered to CS reads "CS", not "Alpha, Beta…". An
 *  excluding filter leaves the sample categories. */
function keptCategories(spec: any): Record<string, string[]> {
  const kept: Record<string, string[]> = {};
  const filters = Array.isArray(spec?.categoricalFilters) ? spec.categoricalFilters : [];
  for (const f of filters) {
    if (f && typeof f.field === "string" && Array.isArray(f.values) && f.values.length && !f.exclude) {
      kept[f.field] = f.values.map((v: unknown) => String(v));
    }
  }
  return kept;
}

const FILTER_LISTS = ["categoricalFilters", "dateRangeFilters", "rangeFilters", "numericRangeFilters", "relativeDateFilters"];

/** One filter in words (the backend's `_fmt_filter`): "Region = West",
 *  "Close Date in the previous 1 quarters", "sum of Sales up to 450000". */
function filterText(f: any): string {
  const field = typeof f.field === "string" && f.field ? f.field : "any field";
  if (f.type === "categorical" || Array.isArray(f.values) || f.limit != null) {
    const values = Array.isArray(f.values) && f.values.length ? f.values.map(String).join(", ") : "";
    if (values) return `${field} ${f.exclude ? "excludes" : "="} ${values}`;
    return f.limit != null ? `${field}: top ${f.limit}` : `${field} (categorical)`;
  }
  if (f.type === "relative-date" || f.period != null) {
    const period = String(f.period ?? "period");
    if (Number(f.amount) === 0) return `${field} in the current ${period.replace(/s$/, "")}`;
    return `${field} in the ${f.direction ?? ""} ${f.amount ?? ""} ${period}`.replace(/\s+/g, " ").trim();
  }
  const subject = f.aggregation && f.aggregation !== "default" ? `${f.aggregation} of ${field}` : field;
  if (f.start != null && f.end != null) return `${subject} between ${f.start} and ${f.end}`;
  if (f.start != null) return `${subject} from ${f.start}`;
  if (f.end != null) return `${subject} up to ${f.end}`;
  return subject;
}

/** What a chart definition filters and sorts, in words, for the line under
 *  its preview. The preview draws sample rows, so without this line two
 *  turns of a conversation that differ only by a filter look the same. */
function specSettingsText(spec: any): string[] {
  const lines: string[] = [];
  for (const key of FILTER_LISTS) {
    const list = Array.isArray(spec?.[key]) ? spec[key] : [];
    for (const f of list) {
      if (f && typeof f === "object") lines.push(`Filtered to ${filterText(f)}`);
    }
  }
  const sort = spec?.sort && typeof spec.sort === "object" ? spec.sort : null;
  if (sort) {
    const by = sort.by ?? sort.field;
    const direction = sort.direction ?? sort.order;
    if (by) lines.push(`Sorted by ${by}${direction ? ` ${direction}` : ""}`);
  } else if (Array.isArray(spec?.fields)) {
    for (const f of spec.fields) {
      if (f && f.sort) lines.push(`Sorted by ${f.caption ?? "field"}${typeof f.sort === "string" ? ` ${f.sort}` : ""}`);
    }
  }
  return lines;
}

function notionalSpecToVegaPreview(
  spec: any,
  size: { width: number; height: number } = { width: 260, height: 180 }
): VisualizationSpec | null {
  if (!spec || !spec.fields || !spec.fields.length) return null;

  const chartType = (spec.chart || "bar").toLowerCase();
  const mark = CHART_TO_MARK[chartType] || "bar";
  const fields = assignVegaChannels(spec.fields);
  const data = generateSyntheticRows(fields, 8, keptCategories(spec));
  const encoding: Record<string, any> = {};

  // Check if we truly have multiple measures that need a fold transform
  // (e.g. "dualline" chart or two measures on the same reassigned channel)
  const measures = fields.filter(
    (f: any) => f.data === "number" || f.role === "measure"
  );
  const stillHasDuplicateMeasures =
    measures.length >= 2 &&
    new Set(measures.map((m: any) => m.encoding)).size === 1;

  if (stillHasDuplicateMeasures && (chartType === "dualline" || measures.length >= 2)) {
    // Multi-measure fold: unpivot into Measure/Value
    const measureNames = measures.map((m: any) => m.caption);
    const dimField = fields.find(
      (f: any) => f.data !== "number" && f.role !== "measure"
    );
    const dimChannel = dimField?.encoding || "x";
    const valChannel = dimChannel === "x" ? "y" : "x";

    if (dimField) {
      const dimEnc: any = { field: dimField.caption, type: getVegaFieldType(dimField) };
      if (TEMPORAL_AGGS.has(dimField.aggregation)) { dimEnc.timeUnit = TIME_UNITS[dimField.aggregation]; dimEnc.type = "temporal"; }
      encoding[dimChannel] = dimEnc;
    }
    encoding[valChannel] = { field: "Value", type: "quantitative" };
    encoding.color = { field: "Measure", type: "nominal" };

    return {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: size.width, height: size.height,
      data: { values: data },
      transform: [{ fold: measureNames, as: ["Measure", "Value"] }],
      mark: { type: mark as any, tooltip: true },
      encoding,
      ...PREVIEW_LAYOUT,
    } as VisualizationSpec;
  }

  // Standard encoding: each field maps to its assigned channel
  for (const f of fields) {
    const ch = f.encoding;
    if (!ch) continue;

    const vegaType = getVegaFieldType(f);
    const enc: any = { field: f.caption, type: vegaType };

    if (f.aggregation && f.aggregation !== "default" && !TEMPORAL_AGGS.has(f.aggregation)) {
      enc.aggregate = f.aggregation;
    }
    if (TEMPORAL_AGGS.has(f.aggregation)) {
      enc.timeUnit = TIME_UNITS[f.aggregation];
      enc.type = "temporal";
    }

    const channel = ch === "size" ? "size" : ch === "color" ? "color" : ch;
    encoding[channel] = enc;
  }

  // Pie/donut: remap to theta + color
  if (mark === "arc") {
    if (encoding.y) { encoding.theta = encoding.y; delete encoding.y; }
    if (encoding.x && !encoding.color) { encoding.color = encoding.x; delete encoding.x; }
  }

  // A text table: the measure is the text, printed per row of the
  // dimension. A text mark with nothing on its text channel drew nothing.
  if (mark === "text") {
    const measureChannel = ["y", "x"].find((c) => encoding[c]?.type === "quantitative");
    const dimensionChannel = ["x", "y"].find((c) => encoding[c] && encoding[c].type !== "quantitative");
    if (measureChannel) {
      encoding.text = { ...encoding[measureChannel], format: ",.0f" };
      delete encoding[measureChannel];
    }
    if (dimensionChannel && dimensionChannel !== "y") {
      encoding.y = encoding[dimensionChannel];
      delete encoding[dimensionChannel];
    }
    if (!encoding.text && !encoding.y) return null;
  }

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    width: size.width, height: size.height,
    data: { values: data },
    mark: { type: mark as any, tooltip: true },
    encoding,
    ...PREVIEW_LAYOUT,
  } as VisualizationSpec;
}

/** Map a notional spec field to a Vega-Lite data type string. */
function getVegaFieldType(f: any): string {
  if (f.data === "date" || TEMPORAL_AGGS.has(f.aggregation)) return "temporal";
  if (f.data === "number" || f.role === "measure") return "quantitative";
  return "nominal";
}

/** What stands in for a chart preview that cannot be drawn: a chart
 *  definition with no fields, or one the chart library rejects. The
 *  definition itself is what the scores compare, so a preview that fails
 *  changes nothing about them. */
const CHART_NOT_DRAWN = "Chart could not be drawn";
const CHART_NOT_DRAWN_NOTE =
  "The chart definition could not be drawn as a preview. The model did return a chart definition, and that is what is scored.";

function ChartPlaceholder({ width, height }: { width: number; height: number }) {
  return (
    <Tooltip title={CHART_NOT_DRAWN_NOTE}>
      <div
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fafafa",
          border: "1px dashed #d9d9d9",
          borderRadius: 4,
          color: "#999",
          fontSize: 12,
          cursor: "help",
        }}
      >
        {CHART_NOT_DRAWN}
      </div>
    </Tooltip>
  );
}

/** Catches a chart library failure while drawing, so the row shows the
 *  placeholder instead of an empty box (a date part the library did not
 *  know left the preview blank, 2026-10-07). */
class ChartErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Render a Vega-Lite preview from a notional spec, with graceful fallback */
function NotionalSpecChart({
  spec,
  width = 260,
  height = 180,
}: {
  spec: any;
  width?: number;
  height?: number;
}) {
  const vegaSpec = useMemo(
    () => notionalSpecToVegaPreview(spec, { width, height }),
    [spec, width, height]
  );
  const settings = useMemo(() => specSettingsText(spec), [spec]);
  // The chart library reports a spec it cannot draw through a callback
  // rather than by throwing; either way the placeholder takes over.
  const [drawFailed, setDrawFailed] = useState(false);
  useEffect(() => setDrawFailed(false), [vegaSpec]);

  // The filters and the sort, which the sample rows cannot show.
  const caption = settings.length ? (
    <div className="chart-preview-settings">
      {settings.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  ) : null;

  if (!vegaSpec || drawFailed) {
    return (
      <div style={{ width, maxWidth: "100%" }}>
        <ChartPlaceholder width={width} height={height} />
        {caption}
      </div>
    );
  }

  // Clipped to its own box as a last resort: a chart must never paint over
  // the column beside it.
  return (
    <ChartErrorBoundary fallback={<ChartPlaceholder width={width} height={height} />}>
      <div className="chart-preview" style={{ width, maxWidth: "100%" }}>
        <VegaLite spec={vegaSpec as any} actions={false} onError={() => setDrawFailed(true)} />
        {caption}
      </div>
    </ChartErrorBoundary>
  );
}

/** Why a row shows a chart the model did not send this turn. */
const UNCHANGED_CHART_NOTE =
  "The model answered without a chart definition, so the chart from the previous turn stays on screen, as it would for a user. That chart is what the scores compare; the reply is the model's answer to this turn.";

// ---------------------------------------------------------------------------
// Display helpers — formatting metric values for table cells and summary cards
// ---------------------------------------------------------------------------

/** Format a 0-1 metric score as a percentage string, or "—" if null. */
function pct(val: number | null): string {
  if (val === null) return "—";
  return `${(val * 100).toFixed(1)}%`;
}

/**
 * Wraps a score in its explanation, shown on hover or click. Scores without
 * one render untouched — no cursor change, no empty popover.
 */
const ScoreExplanation: React.FC<{
  label?: string;
  explanation?: string | null;
  children: React.ReactNode;
}> = ({ label, explanation, children }) => {
  if (!explanation) return <>{children}</>;
  return (
    <Popover
      trigger={["hover", "click"]}
      placement="top"
      destroyTooltipOnHide
      overlayStyle={{ maxWidth: 400 }}
      content={
        <div style={{ maxWidth: 380, fontSize: 13, lineHeight: 1.5 }}>
          {label && <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>}
          {/* A long explanation (a narrative check lists every figure it
              looked at) scrolls inside the popover instead of covering the
              page; its own line breaks are kept. */}
          <div className="score-explanation-text">{explanation}</div>
        </div>
      }
    >
      {/* The dotted underline says "there is a why behind this number": the
          explanation was there but nothing marked it (bug bash 2026-10-23, item 18). */}
      <span className="score-explained" style={{ cursor: "pointer" }}>{children}</span>
    </Popover>
  );
};

/** What the purple marker means; a heading says it on its own tooltip, a
 *  metric row folds it into the metric's definition so the two tooltips
 *  never overlap. */
const JUDGE_SENTENCE = "Scored by the configured evaluator model, not a deterministic metric.";

/** The server's request types (intents) in words. A Tableau Prep intent
 *  suite's one-word answers (calc, flow-plan, other) are shown as they are. */
const INTENT_LABELS: Record<string, string> = {
  NLQ_TO_NOTIONAL_SPEC: "Build a visualization",
  NLQ_TO_UPDATED_NOTIONAL_SPEC: "Change the visualization",
  NLQ_TO_NEW_CALCULATED_FIELD: "Create a calculated field",
  NLQ_TO_UPDATED_CALCULATED_FIELD: "Change a calculated field",
  NLQ_TO_CALCULATED_FIELD_DESCRIPTION: "Describe a calculated field",
  NLQ_TO_CLARIFICATION: "Ask a clarifying question",
  NLQ_TO_UNSUPPORTED: "Not supported",
};

function intentLabel(code: string): string {
  if (INTENT_LABELS[code]) return INTENT_LABELS[code];
  if (!/^NLQ_TO_/.test(code)) return code;
  const words = code.replace(/^NLQ_TO_/, "").toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why a request type stands where an answer would, on hover. */
/** An error message this short never needs the Show More clamp. */
const SHORT_ERROR_CHARS = 120;

function intentNote(code: string, which: "expected" | "actual"): string {
  if (!/^NLQ_TO_/.test(code)) return which === "expected" ? "The expected request type" : "The request type the model detected";
  return which === "expected"
    ? "The kind of request the test case expects"
    : `The model read the request as: ${intentLabel(code)} (${code})`;
}

/** What the chip in the answer column says: for a chart or calculation
 *  case the model answered without a chart or a formula, the fact itself;
 *  the request type it detected is on hover. A Prep intent suite's
 *  one-word answer is the answer and stays as it is. */
function intentChipText(code: string, which: "expected" | "actual"): string {
  if (which === "actual" && /^NLQ_TO_/.test(code)) return "The model returned no chart or calculation to show";
  return intentLabel(code);
}

/** The definition tooltip of a metric row: its gloss, plus the judge
 *  sentence when the judge scored it. */
const metricTooltip = (label: string, judge: boolean): string | undefined => {
  const gloss = METRIC_EXPLAIN[label];
  if (!judge) return gloss;
  return gloss ? `${gloss} ${JUDGE_SENTENCE}` : JUDGE_SENTENCE;
};

/** The purple sparkle alone, for a place that explains it in its own
 *  tooltip (a metric row, a card title). */
const JudgeMark: React.FC = () => (
  <SparklesIcon
    role="img"
    aria-label="Scored by the evaluator model"
    style={{ marginRight: 2, color: "#8B5CF6", fontSize: 14 }}
  />
);

/** Purple marker for judge-derived (llmJudge stage) metrics,
 *  with its own tooltip, for headings that have no other. */
const JudgeTag: React.FC = () => (
  <Tooltip title={JUDGE_SENTENCE}>
    <span style={{ cursor: "help" }}>
      <JudgeMark />
    </span>
  </Tooltip>
);

/** True when every scored leaf of these buckets came from the judge, so
 *  the heading over them earns the judge marker too. */
const allJudge = (buckets: BucketValue[]): boolean => {
  const leaves = buckets.flatMap((b) => b.items);
  return leaves.length > 0 && leaves.every((it) => it.judge);
};

/** What a suite tab's pause/resume button needs from the page. */
interface TabControl {
  /** The request in flight for this run, if any. */
  busy?: "pause" | "resume";
  onPause: (jobId: string) => void;
  onResume: (jobId: string) => void;
}

/**
 * The pause/resume button of a suite's tab. A tab is itself a button, so
 * this is a span with the button role: it keeps its click and its
 * Enter/Space from reaching the tab, which would switch suites instead.
 */
const TabRunControl: React.FC<{
  name: string;
  jobId: string;
  paused: boolean;
  progress: string;
  control: TabControl;
}> = ({ name, jobId, paused, progress, control }) => {
  const { busy } = control;
  const tip = busy === "pause"
    ? "Pausing once the test case in progress finishes"
    : busy === "resume"
    ? "Resuming"
    : paused
    ? `Resume (stopped${progress})`
    : `Pause (in progress${progress})`;
  const act = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    if (paused) control.onResume(jobId);
    else control.onPause(jobId);
  };
  return (
    // The tab strip answers a focus inside a tab by moving focus to the tab
    // itself, which would take the keyboard away from this button: the
    // focus stops here, after the tooltip has seen it.
    <span className="tab-control-wrap" onFocus={(e) => e.stopPropagation()}>
      <Tooltip title={tip}>
        <span
          role="button"
          tabIndex={0}
          className={`tab-control${paused && !busy ? " tab-control-resume" : ""}`}
          aria-label={busy ? tip : `${paused ? "Resume" : "Pause"} ${name}`}
          aria-disabled={busy ? true : undefined}
          onClick={act}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") act(e); }}
        >
          {busy ? <LoadingOutlined /> : paused ? <CaretRightOutlined /> : <PauseOutlined />}
        </span>
      </Tooltip>
    </span>
  );
};

/** A suite's tab: its name, then its status as the same icon the tables
 *  use (queued, complete, failed), named in a tooltip. A running or paused
 *  suite gets a button there instead: pause while it runs, resume once it
 *  is paused. `untested` marks a capability with no run behind its tab. */
function tabLabel(
  rawName: string,
  r: { job_id?: string; status?: string; total?: number; completed?: number; never_started?: boolean; failed_cases?: number } | null | undefined,
  untested = false,
  control?: TabControl,
): React.ReactNode {
  // Tab headers are Title Case; the stored capability names stay as Site
  // Settings names them (chips, table cells, exports).
  const name = titleCase(rawName);
  let word: string | null = null;
  let icon: React.ReactNode = null;
  if (!untested && control && r && r.job_id && (isResumableRun(r) || RUNNING_STATUSES.includes(r.status || ""))) {
    return (
      <span className="tab-status">
        {name}
        <TabRunControl
          name={name}
          jobId={r.job_id}
          paused={isResumableRun(r)}
          progress={r.total ? ` at ${fmtCount(r.completed)} of ${fmtCount(r.total)} test cases` : ""}
          control={control}
        />
      </span>
    );
  }
  if (untested) {
    word = "Not yet tested";
    icon = <MinusCircleOutlined style={{ color: "#8C8C8C" }} />;
  } else if (r && r.status) {
    const info = runStatusInfo(r.status, { neverStarted: r.never_started, failedCases: r.failed_cases, total: r.total });
    word = r.status === "finished" && !(r.failed_cases || 0) ? "Completed" : info.label;
    icon = info.icon;
  }
  if (!word) return name;
  return (
    <span className="tab-status">
      {name}
      <Tooltip title={word}>
        <span className="tab-status-icon" role="img" aria-label={word}>{icon}</span>
      </Tooltip>
    </span>
  );
}

/** What /nlq-eval/summary returns for a settled run. */
interface SuiteSummary {
  overall_score: number | null;
  viz_quality_score: number | null;
  nl_quality_score: number | null;
  /** The capability's own averages, in display order (what every surface lists). */
  headline_scores: HeadlineScore[];
  categories: Array<{ key: string; label: string; weight: number; average: number | null }>;
  cases_total: number;
  cases_completed: number;
  cases_scored: number;
  cases_with_errors: number;
  avg_latency_s: number | null;
}

/**
 * A settled suite's numbers as small tiles inside its card: the
 * capability's headline averages first (the same set the home page lists),
 * then the run's counts.
 */
/** The baseline a suite's scores are read against, as the home page has it. */
type SuiteBaseline = { baseline: number; provisional: boolean } | null;
const BAND_TONE = { higher: "high", "little-lower": "medium", "much-lower": "low" } as const;

/** A suite's summary score (a Result Summary tile, a suite tab's card) as a
 *  pill coloured against the suite's baseline, with the home page's bands;
 *  grey when the suite has no baseline. The band is named on hover. */
function BaselinePill({ value, base, size }: { value: number | null | undefined; base: SuiteBaseline; size: "tile" | "card" }) {
  const className = size === "card" ? "headline-pill card-headline-pill" : "headline-pill";
  if (value == null) return <span className={className} style={{ color: SCORE_NA.color, backgroundColor: SCORE_NA.background }}>—</span>;
  const band = base ? deltaBand(value - base.baseline) : null;
  const tone = band ? SCORE_COLORS[BAND_TONE[band.key]] : SCORE_NA;
  const tip = base && band ? `Baseline ${(base.baseline * 100).toFixed(1)}%: ${band.label}` : "No baseline to compare with";
  return (
    <Tooltip title={tip}>
      <span className={className} style={{ color: tone.color, backgroundColor: tone.background }}>{pct(value)}</span>
    </Tooltip>
  );
}

function SuiteSummaryTiles({ summary, ended, base = null }: { summary: SuiteSummary | null | undefined; ended?: boolean; base?: SuiteBaseline }) {
  if (!summary) {
    return (
      <div className="mini-tiles" aria-busy="true">
        <div className="mini-tile mini-tile-empty"><span className="mini-tile-label">Loading summary…</span></div>
      </div>
    );
  }
  type Tile = { label: React.ReactNode; value: React.ReactNode };
  const scores: Tile[] = (summary.headline_scores || [])
    .filter((h) => h.average != null)
    .map((h) => ({
      label: <>{judgeOnly(h) && <JudgeMark />}{h.label}</>,
      value: <BaselinePill value={h.average} base={base} size="tile" />,
    }));
  const counts: Tile[] = [
    {
      label: "Finished test cases",
      value: (
        <>
          {fmtCount(summary.cases_completed)}
          <Text type="secondary" style={{ fontSize: 12 }}>{` of ${fmtCount(summary.cases_total)}`}</Text>
        </>
      ),
    },
    {
      label: "Average latency",
      value: summary.avg_latency_s == null ? "—" : `${summary.avg_latency_s.toFixed(1)} s`,
    },
    { label: "Test cases with errors", value: summary.cases_with_errors },
  ];
  // The scores on their own row, the counts on the next, so the two
  // kinds of number never share a line. The score row is always there,
  // even with nothing in it, so the count tiles sit at the same height in
  // every card of a row.
  const row = (tiles: Tile[]) => (
    <div className="mini-tiles">
      {tiles.map((t, i) => (
        <div key={i} className="mini-tile">
          <span className="mini-tile-label">{t.label}</span>
          <span className="mini-tile-value">{t.value}</span>
        </div>
      ))}
    </div>
  );
  return (
    <>
      {scores.length > 0 ? row(scores) : (
        <div className="mini-tiles">
          <div className="mini-tile mini-tile-empty">
            <span className="mini-tile-label">{ended ? "No scores for this suite" : "No scores yet"}</span>
          </div>
        </div>
      )}
      {row(counts)}
    </>
  );
}

/**
 * A running or queued suite inside its summary card: how far it is, in the
 * space the score and count tiles take once it has settled.
 */
function SuiteProgress({ completed, total, queued }: { completed: number; total: number; queued?: boolean }) {
  return (
    <div className="suite-progress">
      <Progress
        percent={total ? Math.round((completed / total) * 100) : 0}
        status={queued ? "normal" : "active"}
        label={`${fmtCount(completed)} of ${fmtCount(total)} test cases`}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {queued
          ? "Queued. Waiting for the worker to become available."
          : "Scores appear after the run is paused or is complete."}
      </Text>
    </div>
  );
}

/** A count with thousands separators: 1,006 of 1,160. */
const fmtCount = (n: number | null | undefined): string => (n || 0).toLocaleString("en-US");

/** Format latency in seconds with one decimal, or "—" if null. */
function latencyDisplay(ms: number | null): string {
  if (ms === null) return "—";
  return `${ms.toFixed(1)}s`;
}

/** Extract the user-friendly NL reply from debug_info. */
function extractNlReply(debugInfo: Record<string, any> | null | undefined): string | null {
  if (!debugInfo) return null;
  // CES puts it at debug_info.llm_request.userFriendlyReply
  const reply = debugInfo?.llm_request?.userFriendlyReply;
  if (reply && typeof reply === "string") return reply;
  return null;
}

// ---------------------------------------------------------------------------
// Summary — stat tiles + quality cards, parity with the classic Summary tab
// (results.html `renderSummaryTab`), in the designed FlexCard idiom.
// ---------------------------------------------------------------------------

/** A summary card's title. Hovering or focusing it says what the card
 *  measures and what that tells you about the model. */
function CardTitle({ title, description }: { title: React.ReactNode; description?: string }) {
  if (!description) return <Text type="secondary">{title}</Text>;
  return (
    <Tooltip title={description} placement="topLeft" overlayStyle={{ maxWidth: 360 }}>
      <Text type="secondary">
        <span className="card-title-help" tabIndex={0}>{title}</span>
      </Text>
    </Tooltip>
  );
}

function StatTiles({
  metrics,
  total,
  live,
  onShowErrors,
}: {
  metrics: NlqEvalAggregateMetrics;
  /** The suite is being evaluated right now. */
  live?: boolean;
  /** How many test cases the run was asked to evaluate. A paused run only
   *  has rows for the cases it got to, so the rows on screen are not the
   *  denominator: 1 finished out of 18 is 6%, not "100% of the test cases". */
  total: number;
  /** Sorts the case table errors-first; absent on the summary tab. */
  onShowErrors?: () => void;
}) {
  const denominator = Math.max(total || 0, metrics.totalCases, metrics.completedCases);
  const donePct = denominator
    ? Math.round((metrics.completedCases / denominator) * 100)
    : null;
  const errorPct = metrics.completedCases
    ? Math.round((metrics.errorCount / metrics.completedCases) * 100)
    : null;
  const tiles: Array<{ title: string; description: string; value: React.ReactNode; sub?: React.ReactNode }> = [
    {
      title: "Finished test cases",
      description:
        "A test case is one request with a known expected answer. The scores below are averages over the finished test cases only.",
      value: (
        <>
          {fmtCount(metrics.completedCases)}
          {denominator > 0 && (
            <Text type="secondary" style={{ fontSize: 18, fontWeight: 400 }}>
              {" "}of {fmtCount(denominator)}
            </Text>
          )}
        </>
      ),
      // This capability's own progress, as a bar: how much of its suite the
      // numbers on this tab cover.
      sub:
        donePct !== null ? (
          <Progress
            percent={donePct}
            showInfo={false}
            status={live ? "active" : "normal"}
            label={
              <>
                <Text style={{ color: PRIMARY_COLOR, fontWeight: 600 }}>{donePct}%</Text>
                <Text type="secondary"> of test cases</Text>
              </>
            }
          />
        ) : undefined,
    },
    {
      title: "Average latency",
      description:
        "How long one test case took from sending the request to receiving the full answer, averaged over the finished cases. It includes your Tableau Server and your model's gateway, so lower is better.",
      value:
        metrics.avgLatency === null
          ? "—"
          : `${metrics.avgLatency.toFixed(1)} seconds`,
    },
    {
      // The count is cases, not error messages, and says so. A case with an
      // error can still carry scores (the runner failed one step, the
      // metrics ran on what came back), so the tile reads as a share of the
      // finished cases and leads straight to the cases themselves.
      title: "Test cases with errors",
      description:
        "Test cases where getting or scoring the answer failed, for example a gateway error or a timeout. Many errors usually point to a connection problem rather than a weak model.",
      value: (
        <span style={{ color: metrics.errorCount > 0 ? SCORE_COLORS.low.color : undefined }}>
          {metrics.errorCount}
        </span>
      ),
      sub:
        metrics.errorCount > 0 ? (
          <>
            <Text type="secondary">
              {errorPct !== null ? `${errorPct}% of finished cases` : ""}
              {metrics.warningCount > 0
                ? ` · ${metrics.warningCount} more with warnings only`
                : ""}
            </Text>
            {onShowErrors && (
              <Button
                type="link"
                size="small"
                style={{ paddingLeft: 8, height: 20 }}
                onClick={onShowErrors}
              >
                Show first
              </Button>
            )}
          </>
        ) : metrics.warningCount > 0 ? (
          <Text type="secondary">{metrics.warningCount} with warnings only</Text>
        ) : undefined,
    },
  ];
  return (
    <div className="summary-cards">
      {tiles.map((t) => (
        <Card key={t.title}>
          <CardTitle title={t.title} description={t.description} />
          <div className="card-headline">
            {t.value}
          </div>
          {t.sub ? <div style={{ marginTop: 6, fontSize: 13 }}>{t.sub}</div> : null}
        </Card>
      ))}
    </div>
  );
}

/**
 * Breakdown rows inside a quality card: a bold group row per bucket plus
 * indented leaf rows. Single-leaf buckets whose leaf repeats the bucket
 * label are flattened (classic behavior). Judge leaves carry the purple
 * marker; a present-but-null judge leaf renders "Unavailable".
 */
/** What a case's score pill is, on hover (UX-6): the mean of the category
 *  averages listed under it (the summary cards work the same way), with how
 *  many of the metrics behind them the judge scored, and which listed
 *  categories are there for reference only. */
function averageGloss(buckets: BucketValue[], contextLabels: string[] = []): string {
  const scored = buckets.filter((b) => b.avg != null);
  const leaves = scored.flatMap((b) => b.items).filter((it) => it.value != null);
  const judge = leaves.filter((it) => it.judge).length;
  if (!scored.length) {
    const unavailable = buckets.flatMap((b) => b.items).some((it) => it.judge && it.present && it.value == null);
    return unavailable ? "Unavailable: the evaluator model could not score this case" : "No scores for this case";
  }
  const what =
    scored.length === 1
      ? `The ${scored[0].def.label} average`
      : `Mean of the ${scored.length} category averages below`;
  const judged = judge ? ` (${judge} of the ${leaves.length} metrics scored by the evaluator model)` : "";
  const ref = contextLabels.length ? `; ${contextLabels.join(", ")} shown for reference, not included` : "";
  return `${what}${judged}${ref}`;
}

/** What a reference row in a breakdown is, on its divider. */
const CONTEXT_DIVIDER = "For reference, not in the average";

function BreakdownTable({
  buckets,
  hideGroupRows,
  caseCount,
  contextKeys = [],
}: {
  buckets: BucketValue[];
  hideGroupRows?: boolean;
  /** In a summary card: how many finished test cases the averages are
   *  over. A metric scored for fewer of them says for how many. */
  caseCount?: number;
  /** Categories listed for reference (after a divider, muted, outlined
   *  pills) and left out of the average above the table. */
  contextKeys?: string[];
}) {
  const main = buckets.filter((b) => !contextKeys.includes(b.def.key));
  const context = buckets.filter((b) => contextKeys.includes(b.def.key));
  const renderBucket = (b: BucketValue, isContext: boolean) => {
    const flat =
      !isContext &&
      (hideGroupRows || (b.items.length === 1 && b.items[0].label === b.def.label));
    const rowClass = isContext ? "score-context" : undefined;
    return (
      <React.Fragment key={b.def.key}>
        {!flat && (
          <tr className={rowClass}>
            <td style={{ padding: "6px 8px 2px 0", fontWeight: 600 }}>
              <span className="metric-label">
                {allJudge([b]) && <JudgeTag />}
                <span>{b.def.label}</span>
              </span>
            </td>
            <td style={{ padding: "6px 0 2px" }}>
              <ScorePill val={b.avg} decimals={1} tone={baselineTone(b.avg, b.def.baseline)} />
            </td>
          </tr>
        )}
        {b.items.map((item) => (
          <tr key={item.label} className={rowClass}>
            <td
              style={{
                padding: "2px 8px 2px 0",
                paddingLeft: flat ? 0 : 10,
              }}
            >
              {/* Per-case metric explanations (judge reasoning,
                  threshold details) beat the generic gloss. */}
              <Tooltip
                title={metricTooltip(item.label, item.judge)}
                overlayStyle={{ maxWidth: 440 }}
              >
                <span className="metric-label" style={item.judge ? { cursor: "help" } : undefined}>
                  {item.judge && <JudgeMark />}
                  <span>{item.label}</span>
                </span>
              </Tooltip>
            </td>
                  <td style={{ padding: "2px 0" }}>
                    <ScoreExplanation label={item.label} explanation={item.explanation}>
                      <ScorePill
                        val={item.value}
                        unavailable={item.judge && item.present}
                        decimals={1}
                        tone={baselineTone(item.value, b.def.baseline)}
                      />
                    </ScoreExplanation>
                  </td>
            {caseCount != null && (
              <td className="score-coverage">
                {item.count != null && item.count < caseCount && (
                  <Tooltip title={`Averaged over the ${item.count} of ${caseCount} finished test cases that have a score for this metric`}>
                    <span>{`${item.count} of ${caseCount} cases`}</span>
                  </Tooltip>
                )}
              </td>
            )}
          </tr>
        ))}
      </React.Fragment>
    );
  };
  return (
    <table className="score-breakdown">
      <tbody>
        {main.map((b) => renderBucket(b, false))}
        {context.length > 0 && (
          <tr className="score-context-divider">
            <td colSpan={caseCount != null ? 3 : 2}>{CONTEXT_DIVIDER}</td>
          </tr>
        )}
        {context.map((b) => renderBucket(b, true))}
      </tbody>
    </table>
  );
}

/**
 * A wide summary score card (UX mock): small title, large plain-text
 * percentage, and a "Show Score Breakdowns" link that reveals the bucket
 * table — collapsed by default.
 */
function ScoreCard({
  title,
  description,
  overall,
  buckets,
  hideGroupRows,
  caseCount,
  contextBuckets = [],
  base,
}: {
  title: string;
  /** What the card measures, shown on its title. */
  description?: string;
  overall: number | null;
  buckets: BucketValue[];
  hideGroupRows?: boolean;
  /** Finished test cases behind the averages. */
  caseCount?: number;
  /** Categories listed in the breakdown for reference, not in `overall`. */
  contextBuckets?: BucketValue[];
  /** The suite's baseline, which colours the headline score. */
  base?: SuiteBaseline;
}) {
  const [open, setOpen] = useState(false);
  const judged = allJudge(buckets);
  return (
    <Card>
      <CardTitle
        title={judged ? <><JudgeMark />{title}</> : title}
        description={
          judged ? (description ? `${description} ${JUDGE_SENTENCE}` : JUDGE_SENTENCE) : description
        }
      />
      <div className="card-headline"><BaselinePill value={overall} base={base ?? null} size="card" /></div>
      <Button
        type="link"
        size="small"
        style={{ paddingLeft: 0, marginTop: 4 }}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide score breakdowns" : "Show score breakdowns"}
      </Button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <BreakdownTable
            buckets={[...buckets, ...contextBuckets]}
            hideGroupRows={hideGroupRows}
            caseCount={caseCount}
            contextKeys={contextBuckets.map((b) => b.def.key)}
          />
        </div>
      )}
    </Card>
  );
}

/**
 * The summary card row: Visualization / Natural Language quality cards
 * (classic `_QUALITY_CARDS`), plus standalone cards for the Calculated
 * Fields and Intent & Spec buckets so calc suites aren't summary-less.
 */
function QualityCards({ rows, capability, base = null }: { rows: NlqEvalTableRow[]; capability?: string | null; base?: SuiteBaseline }) {
  const buckets = useMemo(
    () =>
      relabelBuckets(
        computeAggregateBuckets(rows.filter((r) => !r.pending).map((r) => r.metricsByStage)),
        capability,
      ),
    [rows, capability]
  );
  const finished = useMemo(() => rows.filter((r) => !r.pending).length, [rows]);
  const byKey = useMemo(
    () => new Map(buckets.map((b) => [b.def.key, b])),
    [buckets]
  );
  // Runs before 2026-10-13 had the evaluator score similarity and semantic
  // factuality through the site, i.e. by the model under test; such rows
  // carry those names in the evaluator's own stage, not the judge's.
  const judgedByModelUnderTest = useMemo(
    () =>
      rows.some((r) =>
        (r.metricsByStage?.insightNarrative || []).some((m) =>
          ["llmIsSimilar", "Semantic Factuality Precision Rate", "Semantic Factuality Recall Rate"].includes(m.metric_name),
        ),
      ),
    [rows],
  );

  const cards: React.ReactNode[] = [];
  // Categories a card lists for reference are not cards of their own.
  const consumed = new Set<string>();

  for (const card of QUALITY_CARDS) {
    const populated = card.buckets
      .map((k) => byKey.get(k))
      .filter((b): b is BucketValue => !!b);
    if (!populated.length) continue;
    const context = (card.context_buckets || [])
      .map((k) => byKey.get(k))
      .filter((b): b is BucketValue => !!b);
    context.forEach((b) => consumed.add(b.def.key));
    cards.push(
      <ScoreCard
        caseCount={finished}
        key={card.key}
        title={card.label}
        description={CARD_EXPLAIN[card.key]}
        overall={bucketOverall(populated)}
        buckets={populated}
        contextBuckets={context}
        base={base}
      />
    );
  }

  for (const key of ["calc", "match", "palette", "narrative", "flowPlan", "dashboardQA"]) {
    const b = byKey.get(key);
    if (!b || consumed.has(key)) continue;
    const note =
      key === "narrative" && judgedByModelUnderTest
        ? " In this run, Similarity to Expected and Semantic Factuality were scored by the model under test rather than by an evaluator model (runs before 2026-10-13); compare them with later runs with care."
        : "";
    cards.push(
      <ScoreCard
        caseCount={finished}
        key={key}
        title={b.def.label}
        description={CARD_EXPLAIN[key] + note}
        overall={b.avg}
        buckets={[b]}
        hideGroupRows
        base={base}
      />
    );
  }

  if (!cards.length) return null;
  return <div className="summary-cards">{cards}</div>;
}

// ---------------------------------------------------------------------------
// Per-row score columns (UX mock): a score pill with an inline
// "Show Score Breakdowns" toggle that expands the bucket table in the cell.
// ---------------------------------------------------------------------------

/** Bucket keys per score column. Intent & Spec rides in the visualization
 *  column's breakdown (the mock has no separate column for it). */
const VIZ_BUCKET_KEYS = ["data", "semantics", "functionality", "design", "match"];
const NL_BUCKET_KEYS = ["nlFactual", "nlAnalytical", "nlConversation"];
const CALC_BUCKET_KEYS = ["calc", "match"];
const PALETTE_BUCKET_KEYS = ["palette"];
const NARRATIVE_BUCKET_KEYS = ["narrative"];
const FLOW_PLAN_BUCKET_KEYS = ["flowPlan"];
const ANSWER_BUCKET_KEYS = ["dashboardQA"];
/** A suite whose whole answer is the intent (Tableau Prep "Understand the
 *  request") has no visualization or calculation column for the intent
 *  score to ride in, so it gets a column of its own. */
const INTENT_BUCKET_KEYS = ["match"];
/** The buckets each score column of the case table lists. */
const SCORE_COLUMN_BUCKETS = {
  intent: INTENT_BUCKET_KEYS,
  viz: VIZ_BUCKET_KEYS,
  nl: NL_BUCKET_KEYS,
  calc: CALC_BUCKET_KEYS,
  palette: PALETTE_BUCKET_KEYS,
  narrative: NARRATIVE_BUCKET_KEYS,
  flowPlan: FLOW_PLAN_BUCKET_KEYS,
  answer: ANSWER_BUCKET_KEYS,
};
/** Overall excludes the tag-along match bucket so the pill matches the
 *  summary card's number. */
const VIZ_OVERALL_KEYS = ["data", "semantics", "functionality", "design"];

function domainBuckets(buckets: BucketValue[], keys: string[]): BucketValue[] {
  return keys
    .map((k) => buckets.find((b) => b.def.key === k))
    .filter((b): b is BucketValue => !!b);
}

// ---------------------------------------------------------------------------
// Calc-runner rendering (ported from the classic results page): the raw
// debug blob is markdown reasoning followed by a ```json fence carrying
// calc_name / user_friendly_explanation, and the diff toggle shows an
// LCS word-level comparison of the expected vs actual formulas.
// ---------------------------------------------------------------------------

function parseCalcDebug(debugInfo: any): {
  calcName?: string;
  explanation?: string;
  reasoning?: string;
} {
  if (!debugInfo) return {};
  if (typeof debugInfo === "object") {
    const lr = (debugInfo as any).llm_request || {};
    return {
      reasoning: typeof lr.reasoning === "string" ? lr.reasoning : undefined,
      explanation:
        typeof lr.userFriendlyReply === "string" ? lr.userFriendlyReply : undefined,
    };
  }
  if (typeof debugInfo !== "string") return {};
  const match = debugInfo.match(/```json\s*([\s\S]*?)\s*```\s*$/);
  let calcName: string | undefined;
  let explanation: string | undefined;
  let reasoning = debugInfo;
  if (match) {
    reasoning = debugInfo.slice(0, match.index).trim();
    try {
      const parsed = JSON.parse(match[1]);
      if (typeof parsed.calc_name === "string") calcName = parsed.calc_name;
      if (typeof parsed.user_friendly_explanation === "string") {
        explanation = parsed.user_friendly_explanation;
      }
    } catch {
      /* fence wasn't valid JSON — keep it inside the reasoning text */
      reasoning = debugInfo;
    }
  }
  return { calcName, explanation, reasoning: reasoning || undefined };
}

type DiffSeg = { type: "same" | "del" | "ins"; text: string };

/** Word-level LCS diff (classic `computeDiff`): tokens are word runs and
 *  single non-word chars, so brackets/quotes diff cleanly. */
function computeDiff(a: string, b: string): DiffSeg[] {
  const ta = a.match(/[\w]+|[^\w]/g) || [];
  const tb = b.match(/[\w]+|[^\w]/g) || [];
  const m = ta.length;
  const n = tb.length;
  const dp: Uint16Array[] = Array.from(
    { length: m + 1 },
    () => new Uint16Array(n + 1)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        ta[i - 1] === tb[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const segs: DiffSeg[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ta[i - 1] === tb[j - 1]) {
      segs.push({ type: "same", text: ta[--i] });
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segs.push({ type: "ins", text: tb[--j] });
    } else {
      segs.push({ type: "del", text: ta[--i] });
    }
  }
  segs.reverse();
  const merged: DiffSeg[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged;
}

/** One side of the diff: Expected hides insertions, Actual hides deletions. */
function DiffText({ segs, side }: { segs: DiffSeg[]; side: "expected" | "actual" }) {
  return (
    <>
      {segs
        .filter((s) => (side === "expected" ? s.type !== "ins" : s.type !== "del"))
        .map((s, i) =>
          s.type === "same" ? (
            <span key={i}>{s.text}</span>
          ) : s.type === "del" ? (
            <span
              key={i}
              style={{
                color: SCORE_COLORS.low.color,
                background: SCORE_COLORS.low.background,
                textDecoration: "line-through",
              }}
            >
              {s.text}
            </span>
          ) : (
            <span
              key={i}
              style={{ color: SCORE_COLORS.high.color, background: SCORE_COLORS.high.background }}
            >
              {s.text}
            </span>
          )
        )}
    </>
  );
}

/** Monospace code box for calc formulas (classic `.calc-formula`). */
function FormulaBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        background: "#fafafa",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        padding: "8px 10px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

interface FlowPlanStep {
  name: string;
  title?: string;
  explanation?: string;
}

/** The steps of a Tableau Prep flow plan. The expected answer is a list of
 *  step names; the model's answer is a plan object whose `functions` each
 *  name one step. Null when the value is neither. */
function flowPlanSteps(plan: unknown): FlowPlanStep[] | null {
  const list: unknown[] | null = Array.isArray(plan)
    ? plan
    : Array.isArray((plan as any)?.functions)
    ? (plan as any).functions
    : null;
  if (!list) return null;
  const steps: FlowPlanStep[] = [];
  for (const s of list as any[]) {
    if (typeof s === "string") steps.push({ name: s });
    else if (s && typeof s.functionName === "string") {
      steps.push({
        name: s.functionName,
        title: typeof s.title === "string" ? s.title : undefined,
        explanation: typeof s.explanation === "string" ? s.explanation : undefined,
      });
    }
  }
  return steps;
}

/** A flow plan as a numbered list of its steps. A step of the model's plan
 *  also shows the title the model gave it, and its explanation on hover. */
function FlowPlanSteps({ steps }: { steps: FlowPlanStep[] }) {
  if (!steps.length) return <Text type="secondary">A plan with no steps</Text>;
  return (
    <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.55 }}>
      {steps.map((s, i) => {
        // Step names are long single words (FilterValuesByRelativeDateFilter);
        // the text font keeps them on one line in a results column.
        const name = <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{s.name}</span>;
        return (
          <li key={i} style={{ marginBottom: 2 }}>
            {s.explanation ? <Tooltip title={s.explanation}>{name}</Tooltip> : name}
            {s.title && (
              <div>
                <Text type="secondary">{s.title}</Text>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Recursive section renderer for CES's structured narrative document
 *  ({ sections: [{ type, heading, body, children }] }). */
function NarrativeSection({ node, depth }: { node: any; depth: number }) {
  if (!node || depth > 4) return null;
  return (
    <div style={{ paddingLeft: depth > 0 ? 10 : 0, marginBottom: depth === 0 ? 6 : 2 }}>
      {node.heading && (
        <div style={{ fontWeight: 600 }}>{node.heading}</div>
      )}
      {node.body && <div>{node.body}</div>}
      {Array.isArray(node.children) &&
        node.children.map((c: any, i: number) => (
          <NarrativeSection key={i} node={c} depth={depth + 1} />
        ))}
    </div>
  );
}

/** Dashboard-narrative output: expected narratives are plain text; actual
 *  ones arrive as a JSON string holding CES's sections document. Parse
 *  when possible, fall back to the raw text. */
function NarrativeBlock({ text }: { text: string }) {
  let content: React.ReactNode = text;
  const s = text.trim();
  if (s.startsWith("{")) {
    try {
      const doc = JSON.parse(s);
      if (Array.isArray(doc?.sections)) {
        content = doc.sections.map((sec: any, i: number) => (
          <NarrativeSection key={i} node={sec} depth={0} />
        ));
      }
    } catch {
      /* not JSON — render the raw text */
    }
  }
  return (
    <div
      style={{
        background: "#f5f5f7",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 12,
        lineHeight: 1.5,
        maxHeight: 200,
        overflowY: "auto",
      }}
    >
      {content}
    </div>
  );
}

/** Color-palette runner output: a strip of swatch chips with hex tooltips. */
function PaletteSwatches({ colors }: { colors: string[] }) {
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, maxWidth: 230 }}>
        {colors.map((c, i) => (
          <Tooltip key={`${c}-${i}`} title={c}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                background: c,
                border: "1px solid rgba(0,0,0,0.15)",
              }}
            />
          </Tooltip>
        ))}
      </div>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {colors.length} colors
      </Text>
    </div>
  );
}

/** A score column: the pill, the breakdown link, a two-line title at most,
 *  and a breakdown's label beside its pill (the breakdown is laid out to
 *  the column's width, index.css). Grows with the window; this is its
 *  minimum, and a calculated-fields table fits the page exactly at it. */
const SCORE_COLUMN_WIDTH = 176;
/** The visualization and natural language columns: their breakdowns carry
 *  the longest category names ("Conversation quality", "Information
 *  Similarity"), which were cut off under the pill at 176px. */
const WIDE_SCORE_COLUMN_WIDTH = 232;

/** Which columns of the results table are hidden and in what order they
 *  stand, kept in the browser so a choice holds across runs. The pinned
 *  Latency and Error columns keep their place; the Row column cannot be
 *  hidden, so the table always has an anchor. */
const COLUMN_SETTINGS_KEY = "ai_eval_results_columns";
const LOCKED_COLUMNS = new Set(["index"]);
interface ColumnSettings { order: string[]; hidden: string[] }
const NO_COLUMN_SETTINGS: ColumnSettings = { order: [], hidden: [] };
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
function readColumnSettings(): ColumnSettings {
  try {
    const raw = window.localStorage.getItem(COLUMN_SETTINGS_KEY);
    if (!raw) return NO_COLUMN_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ColumnSettings>;
    return { order: strings(parsed.order), hidden: strings(parsed.hidden).filter((k) => !LOCKED_COLUMNS.has(k)) };
  } catch {
    return NO_COLUMN_SETTINGS;
  }
}
function writeColumnSettings(settings: ColumnSettings) {
  try {
    if (!settings.order.length && !settings.hidden.length) window.localStorage.removeItem(COLUMN_SETTINGS_KEY);
    else window.localStorage.setItem(COLUMN_SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private window, blocked storage: the choice lasts the page */ }
}
/** The columns in the saved order. A column the saved order does not know
 *  (a score column of another kind of suite) keeps its place after the
 *  nearest column before it that the order does know. */
function arrangeColumns<T>(columns: ColumnsType<T>, order: string[]): ColumnsType<T> {
  const movable = columns.filter((c) => c.fixed !== "right");
  const pinned = columns.filter((c) => c.fixed === "right");
  let last = -1;
  const ranked = movable.map((c, i) => {
    const at = order.indexOf(String(c.key));
    if (at >= 0) last = at;
    return { c, rank: at >= 0 ? at : last + 0.5, i };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return [...ranked.map((r) => r.c), ...pinned];
}
const columnName = <T,>(c: ColumnType<T>) => c.label ?? (typeof c.title === "string" ? c.title : String(c.key));

/** True once `flag` has held for `delayMs`: a connection that drops and is
 *  back within a second or two never shows a "Reconnecting" note. */
function useSettledFlag(flag: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!flag) { setSettled(false); return undefined; }
    const timer = window.setTimeout(() => setSettled(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [flag, delayMs]);
  return flag && settled;
}

/** The "Columns" button above the results table: show or hide each column,
 *  move one up or down (a header can also be dragged), reset. */
function ColumnPicker<T>({ columns, hidden, changed, onToggle, onStep, onReset }: {
  columns: ColumnsType<T>;
  hidden: Set<string>;
  changed: boolean;
  onToggle: (key: string) => void;
  onStep: (key: string, direction: -1 | 1) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const movable = columns.filter((c) => c.fixed !== "right");
  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      open={open}
      onOpenChange={setOpen}
      content={
        <div className="column-picker" role="group" aria-label="Table columns">
          {columns.map((c) => {
            const key = String(c.key);
            const name = columnName(c);
            const at = movable.indexOf(c);
            return (
              <div className="column-picker-row" key={key}>
                <Checkbox checked={!hidden.has(key)} disabled={LOCKED_COLUMNS.has(key)} onChange={() => onToggle(key)}>
                  {name}
                </Checkbox>
                {c.fixed === "right" ? (
                  <Text type="secondary" style={{ fontSize: 11 }}>Pinned</Text>
                ) : (
                  <span className="column-picker-moves">
                    <button type="button" className="tui-page-btn" aria-label={`Move ${name} up`} disabled={at <= 0} onClick={() => onStep(key, -1)}>
                      <UpOutlined />
                    </button>
                    <button type="button" className="tui-page-btn" aria-label={`Move ${name} down`} disabled={at >= movable.length - 1} onClick={() => onStep(key, 1)}>
                      <DownOutlined />
                    </button>
                  </span>
                )}
              </div>
            );
          })}
          <div className="column-picker-foot">
            <Text type="secondary" style={{ fontSize: 11 }}>Drag a column header to move it.</Text>
            <Button type="link" size="small" style={{ padding: 0 }} disabled={!changed} onClick={() => { onReset(); setOpen(false); }}>
              Reset Columns
            </Button>
          </div>
        </div>
      }
    >
      <Tooltip title="Show, hide, or reorder the table's columns">
        <Button size="small" aria-expanded={open} aria-haspopup="true">Columns</Button>
      </Tooltip>
    </Popover>
  );
}

function RowScoreCell({
  buckets,
  overallKeys,
  open,
  onToggle,
}: {
  buckets: BucketValue[];
  overallKeys?: string[];
  open: boolean;
  onToggle: () => void;
}) {
  if (!buckets.length) return <span style={NA_PILL_STYLE}>—</span>;
  const overallSet = overallKeys ? domainBuckets(buckets, overallKeys) : buckets;
  const averaged = overallSet.length ? overallSet : buckets;
  const overall = bucketOverall(averaged);
  // A category with its own baseline (the Prep suites') is coloured against it.
  const baseline = new Set(averaged.map((b) => b.def.baseline)).size === 1 ? averaged[0].def.baseline : undefined;
  const tone = baselineTone(overall, baseline);
  // Listed under the pill for reference, not in it (Intent and Spec in the
  // visualization column).
  const contextKeys = buckets
    .filter((b) => !averaged.includes(b))
    .map((b) => b.def.key);
  const unavailable = overall == null && buckets.some((b) => b.items.some((it) => it.judge && it.present && it.value == null));
  return (
    <div>
      <Tooltip
        title={
          averageGloss(averaged, contextKeys.map((k) => buckets.find((b) => b.def.key === k)?.def.label || k)) +
          (tone && baseline != null ? `. Baseline ${(baseline * 100).toFixed(1)}%: ${tone.label}` : "")
        }
      >
        <span style={{ cursor: "help" }}>
          <ScorePill val={overall} unavailable={unavailable} decimals={1} tone={tone} />
        </span>
      </Tooltip>
      <div>
        <Button
          type="link"
          size="small"
          style={{ padding: 0, fontSize: 12, height: 22 }}
          onClick={onToggle}
        >
          {open ? "Hide score breakdowns" : "Show score breakdowns"}
        </Button>
      </div>
      {open && (
        <div style={{ marginTop: 4 }}>
          <BreakdownTable
            buckets={buckets}
            hideGroupRows={averaged.length === 1}
            contextKeys={contextKeys}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component — routed at /results/:jobId
// ---------------------------------------------------------------------------

/**
 * NlqResultsPage is the interactive results viewer for BYOLLM evaluation jobs.
 * It is loaded by navigating to /results/:jobId (e.g. from VPC's "View Results" link).
 *
 * Layout:
 *   - Header with job metadata (model, runner, status)
 *   - Progress bar (visible only while streaming)
 *   - Aggregate metrics cards
 *   - Search/filter controls
 *   - Sortable results table with expandable row detail (expected vs actual specs)
 */
/** One capability of a feature on the feature results page: its public
 *  full suite, the run shown for it (the newest, or a past one the admin
 *  picked), and the runs it has to pick from. */
interface FeatureMember {
  cat: CategoryDef;
  suite: Suite | undefined;
  run: RunRecord | null;
  history: RunRecord[];
}

const NlqResultsPage: React.FC = () => {
  const { jobId: routeJobId, feature: featureParam } = useParams<{ jobId?: string; feature?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Feature mode (/results/feature/<feature>): the feature's latest results,
  // one tab per capability, each showing that capability's newest run of
  // its public full suite (decision of 2026-09-30). ?job= pins a past run of
  // one capability; ?capability= picks the tab to land on.
  const featureMode = Boolean(featureParam);
  const featureKey = (featureParam || null) as FeatureKey | null;
  const featureDefn = featureKey ? featureDef(featureKey) : null;
  const pinnedJob = searchParams.get("job");
  // "View Results" on a suite card opens that suite's own tab, not the
  // summary again: the link carries ?tab=runner.
  const wantedTab = searchParams.get("tab");
  const wantedCapability = searchParams.get("capability");
  const [members, setMembers] = useState<FeatureMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  // Each suite's baseline from the suite list, for colouring its summary
  // scores the way the home page does.
  const [suiteBaselines, setSuiteBaselines] = useState<Record<string, NonNullable<SuiteBaseline>>>({});
  const baselineOfSuite: BaselineLookup = useCallback(
    (suiteId) => (suiteId && suiteBaselines[suiteId]) || null,
    [suiteBaselines],
  );
  // The baseline a suite's summary scores are coloured against: the
  // capability's, from the catalog this build ships (the same value the
  // table's pills use), else the suite's from the server's suite list.
  const baseOf = useCallback((capabilityId: string | null | undefined, suiteId: string | null | undefined): SuiteBaseline => {
    const fromCatalog = capabilityBaseline(capabilityId);
    return fromCatalog != null ? { baseline: fromCatalog, provisional: false } : baselineOfSuite(suiteId);
  }, [baselineOfSuite]);
  // The run records: a suite's history and its siblings come from these,
  // not from the stream.
  const [allRuns, setAllRuns] = useState<RunRecord[]>([]);
  // Suites launched together share a batch id. Their results live in
  // separate jobs, so the page offers a tab per runner and switching tabs
  // navigates — each job keeps streaming on its own. In feature mode the
  // "siblings" are the capabilities' runs.
  const [listedSiblings, setSiblings] = useState<RunRecord[]>([]);
  const siblings = useObservedRunRecords(listedSiblings);
  const [siblingsTick, setSiblingsTick] = useState(0);
  const siblingsLoading = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    siblingsLoading.current = true;
    const load = async () => {
      const runsReq = fetch(`${API_BASE}/nlq-eval/runs?limit=200`, { signal: controller.signal }).then((r) => r.json());
      const suitesReq = fetch(`${API_BASE}/nlq-eval/suites`, { signal: controller.signal }).then((r) => r.json()).catch(() => ({}));
      if (!featureMode) {
        // A run's page groups it with the other suites of its evaluation as
        // soon as the run list arrives, without waiting for the suite list:
        // until then the page showed the first suite alone, then switched
        // to the evaluation (2026-10-19). The suite list below only fills in
        // the totals of suites still queued.
        const early = await runsReq;
        if (cancelled) return;
        const meEarly = (early.runs || []).find((r: RunRecord) => r.job_id === routeJobId);
        const batchEarly = meEarly?.batch_id;
        if (batchEarly) {
          const groupEarly = (early.runs || [])
            .filter((r: RunRecord) => r.batch_id === batchEarly)
            .sort((a: RunRecord, c: RunRecord) => String(a.created_at || "").localeCompare(String(c.created_at || "")));
          setSiblings(groupEarly);
        }
      }
      const [b, sb] = await Promise.all([runsReq, suitesReq]);
      // A run has no total until it starts and its cases are loaded. For a
      // suite still waiting in the queue the catalog's case count stands in,
      // so the progress across a batch counts every suite from the first
      // moment instead of growing each time the next one starts.
      const caseCounts = new Map<string, number>(
        (sb.suites || []).map((x: Suite) => [x.id, x.case_count || 0]),
      );
      const all: RunRecord[] = (b.runs || []).map((r: RunRecord) =>
        !r.total && r.status === "queued" && r.suite_id && caseCounts.get(r.suite_id)
          ? { ...r, total: caseCounts.get(r.suite_id) }
          : r,
      );
      const suites: Suite[] = (sb.suites || []).filter(
        (x: Suite) => !x.ui_hidden && x.visibility === "public",
      );
      if (cancelled) return;
      setAllRuns(all);
      setSuiteBaselines(Object.fromEntries(
        (sb.suites || [])
          .filter((x: Suite) => typeof x.baseline === "number")
          .map((x: Suite) => [x.id, { baseline: x.baseline as number, provisional: Boolean(x.baseline_provisional) }]),
      ));
      if (featureMode) {
        const next: FeatureMember[] = CATEGORIES.filter((c) => c.feature === featureKey).map((cat) => {
          const suite = publicFullSuite(cat, suites);
          // Newest first, as the runs endpoint lists them. A capability with
          // several public suites (Questions about a dashboard, one per sample
          // dashboard) shows the runs of all of them.
          const siblingIds = new Set(
            suites.filter((x) => cat.capabilities.includes(x.capability) && x.available).map((x) => x.id),
          );
          // A suite made of other suites (Questions about a dashboard): the
          // parts' own earlier runs stay in the capability's history.
          suites.forEach((x) => {
            if (cat.capabilities.includes(x.capability)) (x.parts || []).forEach((pt) => siblingIds.add(pt.id));
          });
          if (suite) siblingIds.add(suite.id);
          const history = suite ? all.filter((r) => siblingIds.has(r.suite_id || "")) : [];
          const pinned = pinnedJob ? history.find((r) => r.job_id === pinnedJob) : undefined;
          return {
            cat,
            suite,
            run: pinned || history[0] || null,
            history,
          };
        });
        if (cancelled) return;
        setMembers(next);
        setSiblings(next.flatMap(m => m.run ? [m.run] : []));
        setMembersLoaded(true);
        return;
      }
      if (cancelled) return;
      const me = all.find((r) => r.job_id === routeJobId);
      const batch = me?.batch_id;
      const group = batch ? all.filter((r) => r.batch_id === batch) : [];
      // Launch order, so the tab strip is identical on every suite's page.
      group.sort((a, b) =>
        String(a.created_at || "").localeCompare(String(b.created_at || "")),
      );
      setSiblings(group);
    };
    // A failed read (a backend restart, a dropped connection) is tried
    // again shortly: in feature mode the page has nothing to show until
    // this list arrives.
    let retry: ReturnType<typeof setTimeout> | undefined;
    load().catch(() => {
      if (!cancelled) retry = setTimeout(() => setSiblingsTick((t) => t + 1), 2000);
    }).finally(() => {
      if (!cancelled) siblingsLoading.current = false;
    });
    return () => {
      cancelled = true;
      controller.abort();
      siblingsLoading.current = false;
      if (retry) clearTimeout(retry);
    };
    // Re-read when the stream changes phase, so the batch tag and the side
    // panel follow queued → started → finished without a page reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeJobId, featureKey, pinnedJob, wantedCapability, siblingsTick]);
  // The job on screen: the route's in run mode; in feature mode the pinned
  // run, else the run of the capability asked for, else the first
  // capability that has one.
  const featureJobId = useMemo(() => {
    if (!featureMode) return undefined;
    if (pinnedJob && members.some((m) => m.run?.job_id === pinnedJob)) return pinnedJob;
    const wanted = members.find((m) => m.cat.key === wantedCapability);
    if (wanted?.run) return wanted.run.job_id;
    return members.find((m) => m.run)?.run?.job_id;
  }, [featureMode, members, pinnedJob, wantedCapability]);
  const jobId = featureMode ? featureJobId : routeJobId;
  const runRecord = useMemo(() => allRuns.find((r) => r.job_id === jobId) || null, [allRuns, jobId]);
  /** The page for a run: in feature mode it stays on the feature page. */
  const resultsPath = (targetJob: string) =>
    featureMode
      ? `/results/feature/${featureKey}?job=${targetJob}&tab=runner`
      : `/results/${targetJob}?tab=runner`;

  // Summaries of the settled suites (paused, finished, failed, cancelled),
  // keyed by job id; re-fetched when a suite's status or case count moves.
  const [suiteSummaries, setSuiteSummaries] = useState<Record<string, { stamp: string; data: SuiteSummary | null }>>({});
  useEffect(() => {
    siblings
      .filter((sib) => sib.status && !ACTIVE_STATUSES.includes(sib.status) && !sib.never_started)
      .forEach((sib) => {
        const stamp = `${sib.status}:${sib.completed || 0}:${(sib as RunRecord & { revision?: number }).revision ?? ""}`;
        if (suiteSummaries[sib.job_id]?.stamp === stamp) return;
        setSuiteSummaries((prev) => ({ ...prev, [sib.job_id]: { stamp, data: prev[sib.job_id]?.data || null } }));
        // The answer is kept whenever it arrives: the siblings list is
        // re-read every few seconds, and dropping an answer that landed
        // after a re-read left the card on "Loading summary…" for good
        // (its stamp already said "asked"). A failure clears the stamp so
        // the next re-read asks again.
        const forget = () =>
          setSuiteSummaries((prev) =>
            prev[sib.job_id]?.stamp === stamp
              ? { ...prev, [sib.job_id]: { stamp: "", data: prev[sib.job_id]?.data || null } }
              : prev,
          );
        fetch(`${API_BASE}/nlq-eval/summary/${sib.job_id}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data) return forget();
            setSuiteSummaries((prev) =>
              prev[sib.job_id]?.stamp === stamp ? { ...prev, [sib.job_id]: { stamp, data } } : prev,
            );
          })
          .catch(forget);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siblings]);
  const { state: loadedState, reload } = useNlqEvalStream(jobId);
  // A short drop in the live connection is not worth a note; a long one is.
  const reconnecting = useSettledFlag(loadedState.connection === "reconnecting", 1500);
  const [columnSettings, setColumnSettings] = useState<ColumnSettings>(readColumnSettings);
  const updateColumnSettings = useCallback((next: ColumnSettings) => {
    setColumnSettings(next);
    writeColumnSettings(next);
  }, []);
  // While a run's rows are on their way the page already knows the run from
  // the runs list, so the header and the tab strip stay on screen and only
  // the tab's body waits (switching suite tabs used to blank the whole page).
  const state = useMemo(() => {
    // A run shown as it was on an earlier visit, before the server has been
    // asked again: its status and counts come from the run record, which is
    // what its tab showed a moment ago. Without this the tab flipped to the
    // remembered status (say Paused) and then to the real one (Running).
    if (loadedState.status !== "loading" || loadedState.run || !runRecord) return loadedState;
    return {
      ...loadedState,
      run: {
        job_id: runRecord.job_id,
        org_id: "",
        user_id: "",
        ai_feature: runRecord.ai_feature || "",
        runner_name: runRecord.runner_name || "",
        config: {},
        status: runRecord.status,
        total: runRecord.total || 0,
        completed: runRecord.completed || 0,
        error: runRecord.error ?? null,
        created_at: runRecord.created_at || "",
        finished_at: runRecord.finished_at ?? null,
      } as NlqEvalRun,
    };
  }, [loadedState, runRecord]);
  // Launching a capability from its card (feature mode).
  const [launchingCat, setLaunchingCat] = useState<string | null>(null);
  const [connReady, setConnReady] = useState<boolean | null>(null);
  // Why launching is blocked when it is: a server earlier than 2026.3 (no AI
  // endpoint) has its own explanation; anything else is "connect first".
  const [launchBlocked, setLaunchBlocked] = useState<string>(
    "Connect your Tableau Server first (home page, Evaluation Setup)",
  );
  useEffect(() => {
    if (!featureMode) return;
    fetch(`${API_BASE}/nlq-eval/settings/tableau`)
      .then((r) => r.json())
      .then((c) => {
        setConnReady(Boolean(c.configured && c.last_verified?.ok));
        const tooOld = c.last_verified?.server_too_old;
        if (tooOld?.message) setLaunchBlocked(tooOld.message);
      })
      .catch(() => setConnReady(false));
  }, [featureMode]);
  const launchMember = async (m: FeatureMember) => {
    if (!m.suite || !m.suite.available || !m.suite.path) return;
    setLaunchingCat(m.cat.key);
    try {
      const judgeReady = await fetchJudgeReady();
      const launched = await launchSuite(m.suite, { judgeReady });
      message.success(`Evaluating ${m.cat.label}`);
      launched.warnings.forEach((w) => message.warning(w));
      navigate(`/results/feature/${featureKey}?job=${launched.jobId}`);
      setSiblingsTick((t) => t + 1);
    } catch (e: any) {
      message.error(e.message);
    }
    setLaunchingCat(null);
  };
  useEffect(() => {
    setSiblingsTick((t) => t + 1);
  }, [state.status]);

  const [searchText, setSearchText] = useState("");
  const [datasourceFilter, setDatasourceFilter] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // The stored Tableau connection (configured once in the dashboard's
  // settings drawer) is the publish target — no per-publish credentials.
  const [tableauConn, setTableauConn] = useState<any>(null);
  useEffect(() => {
    if (!publishOpen) return;
    fetch(`${API_BASE}/nlq-eval/settings/tableau`)
      .then((r) => r.json())
      .then(setTableauConn)
      .catch(() => setTableauConn({ configured: false }));
  }, [publishOpen]);

  const [bulkBusy, setBulkBusy] = useState<"pause" | "resume" | null>(null);
  /** Pause every running or queued suite of the evaluation (a queued suite
   *  stops before its first case when its turn comes). Pause queued siblings
   *  first: aborting the running suite releases the worker immediately. */
  const pauseAll = async () => {
    setBulkBusy("pause");
    const targets = (siblings.length > 1 ? siblings : state.run ? [state.run] : [])
      .filter((r) => ACTIVE_STATUSES.includes(r.status));
    let ok = 0;
    const batchId = siblings.length > 1 ? siblings[0]?.batch_id : undefined;
    if (batchId) {
      try {
        const res = await fetch(`${API_BASE}/nlq-eval/batches/${encodeURIComponent(batchId)}/pause`, { method: "POST" });
        if (res.ok) ok = Number((await res.json()).paused);
      } catch { /* counted below */ }
    } else {
      const outcomes = await Promise.allSettled(targets.map(r =>
        fetch(`${API_BASE}/nlq-eval/pause/${r.job_id}`, { method: "POST" })));
      ok = outcomes.filter(r => r.status === "fulfilled" && r.value.ok).length;
    }
    setBulkBusy(null);
    if (ok) message.success(ok === 1 ? "Pause requested" : `Pause requested for ${ok} suites`);
    else message.error("No suite could be paused. Try again.");
    if (!ok) reload();
    setSiblingsTick((t) => t + 1);
  };
  /** Resume every paused suite, in launch order: one server-side command
   *  for a batch, so the suites re-queue in the order they were launched. */
  const resumeAll = async () => {
    setBulkBusy("resume");
    const targets = (siblings.length > 1 ? siblings : state.run ? [state.run] : [])
      .filter((r) => isResumableRun(r));
    let ok = 0;
    let refusal = "";
    const batchId = siblings.length > 1 ? siblings[0]?.batch_id : undefined;
    if (batchId) {
      try {
        const res = await fetch(`${API_BASE}/nlq-eval/batches/${encodeURIComponent(batchId)}/resume`, { method: "POST" });
        const body = await res.json().catch(() => ({}));
        if (res.ok) ok = Number(body.resumed);
        if (body.error) refusal = String(body.error);
      } catch { /* counted below */ }
    } else {
      for (const r of targets) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await fetch(`${API_BASE}/nlq-eval/resume/${r.job_id}`, { method: "POST" });
          if (res.ok) ok += 1;
          else refusal = String((await res.json().catch(() => ({}))).error || "");
        } catch { /* counted below */ }
      }
    }
    setBulkBusy(null);
    if (ok) message.success(ok === 1 ? "Resumed — completed cases are skipped" : `Resumed ${ok} suites — completed cases are skipped`);
    else message.error(refusal || "No suite could be resumed. Try again.");
    if (ok && refusal) message.warning(refusal);
    if (!ok) reload();
    setSiblingsTick((t) => t + 1);
  };

  /** POST a job-control verb (pause/resume/cancel), then re-run the loader. */
  const jobAction = async (verb: string, okMsg: string, targetJob?: string): Promise<boolean> => {
    let ok = true;
    try {
      const res = await fetch(`${API_BASE}/nlq-eval/${verb}/${targetJob || jobId}`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || httpErrorText(res.status));
      message.success(okMsg);
       // The committed change arrives on the existing observation subscription.
    } catch (e: any) {
      message.error(e.message);
      ok = false;
    }
    if (!ok) reload();
    // The batch header and the side panel read the run records, not the
    // stream: re-read them so a pause/resume/cancel shows within a moment
    // even when it targeted a sibling suite (bug bash S2-3/S2-4).
    setSiblingsTick((t) => t + 1);
    return ok;
  };

  // Cancel every unfinished suite, including queued and paused siblings.
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancelAll = async () => {
    setCancelBusy(true);
    const targets = (siblings.length > 1 ? siblings : state.run ? [state.run] : [])
      .filter((r) => ACTIVE_STATUSES.includes(r.status) || r.status === "paused");
    let ok = 0;
    const batchId = siblings.length > 1 ? siblings[0]?.batch_id : undefined;
    if (batchId) {
      // One server-side transaction, so cancelling the live suite cannot
      // start an untouched queued sibling.
      try {
        const res = await fetch(`${API_BASE}/nlq-eval/batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" });
        if (res.ok) ok = Number((await res.json()).cancelled);
      } catch { /* counted below */ }
    } else {
      const outcomes = await Promise.allSettled(targets.map((r) =>
        fetch(`${API_BASE}/nlq-eval/cancel/${r.job_id}`, { method: "POST" }),
      ));
      ok = outcomes.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    }
    setCancelBusy(false);
    if (ok && (batchId || ok === targets.length)) message.success(ok === 1 ? "Canceled" : `Canceled ${ok} suites`);
    else if (ok) message.warning(`Canceled ${ok} of ${targets.length} suites. Try again for the remaining suites.`);
    else message.error("No suite could be canceled. Try again.");
    if (!ok) reload();
    setSiblingsTick((t) => t + 1);
  };

  // The pause/resume button on a suite's tab shows pending until the API
  // acknowledges the control request and the refreshed run reports it.
  const [tabBusy, setTabBusy] = useState<Record<string, "pause" | "resume">>({});
  const clearTabBusy = (jobs: string[]) =>
    setTabBusy((prev) => {
      const next = { ...prev };
      jobs.forEach((j) => delete next[j]);
      return next;
    });
  const tabAction = async (verb: "pause" | "resume", targetJob: string) => {
    setTabBusy((prev) => ({ ...prev, [targetJob]: verb }));
    const ok = await jobAction(verb, verb === "pause" ? "Pause requested" : "Resumed", targetJob);
    // A resume has been waited for by now; a pause that was accepted stays
    // pending until the run stops (the effect below).
    if (!ok || verb === "resume") clearTabBusy([targetJob]);
  };
  const tabControlFor = (targetJob: string | undefined): TabControl => ({
    busy: targetJob ? tabBusy[targetJob] : undefined,
    onPause: (j) => tabAction("pause", j),
    onResume: (j) => tabAction("resume", j),
  });
  useEffect(() => {
    const stopped = Object.keys(tabBusy).filter((job) => {
      if (tabBusy[job] !== "pause") return false;
      const status =
        (job === jobId ? loadedState.run?.status : undefined) ||
        siblings.find((sib) => sib.job_id === job)?.status;
      return Boolean(status) && !RUNNING_STATUSES.includes(status as string);
    });
    if (stopped.length) clearTabBusy(stopped);
  }, [tabBusy, siblings, loadedState.run, jobId]);


  // While any suite of this evaluation is still going, re-read the run
  // records every second (the dashboard does the same) so the batch tag, the
  // "Now:" line and the side panel follow a sibling that is not the run on
  // screen — its events never reach this page's stream (bug bash S2-4).
  const anySuiteLive =
    siblings.some((sib) => ACTIVE_STATUSES.includes(sib.status)) ||
    ACTIVE_STATUSES.includes(state.run?.status || "");
  useEffect(() => {
    if (!anySuiteLive) return undefined;
    const timer = setInterval(() => {
      if (!siblingsLoading.current) setSiblingsTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [anySuiteLive]);

  /** Publish to Tableau Server using the stored connection —
   *  the backend fills server/site/PAT/TLS from settings. */
  const doPublish = async () => {
    setPublishing(true);
    try {
      const res = await fetch(`${API_BASE}/nlq-eval/publish/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || httpErrorText(res.status));
      message.success(
        `Results published to "${body.datasource || PUBLISH_DATASOURCE}"`
      );
      setPublishOpen(false);
    } catch (e: any) {
      message.error(e.message);
    }
    setPublishing(false);
  };

  // The run's capability names its categories: a Tableau Prep calculation
  // run shows "Calculated Fields in Flows" where a calc run shows
  // "Calculated Fields".
  const capability = state.run?.ai_feature || runRecord?.ai_feature || null;
  /** "Calculated fields in flows": a category name as a table header. */
  const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  // Per-row bucket values feed the score columns; a column renders only
  // when at least one row has data for its domain.
  const rowBuckets = useMemo(() => {
    const m = new Map<string, BucketValue[]>();
    for (const r of state.rows) {
      m.set(r.key, r.pending ? [] : relabelBuckets(computeRowBuckets(r.metricsByStage), capability));
    }
    return m;
  }, [state.rows, capability]);

  const domainPresence = useMemo(() => {
    let viz = false, nl = false, calc = false, palette = false, narrative = false;
    let flowPlan = false, answer = false, match = false;
    rowBuckets.forEach((buckets) => {
      if (domainBuckets(buckets, INTENT_BUCKET_KEYS).length) match = true;
      if (domainBuckets(buckets, VIZ_OVERALL_KEYS).length) viz = true;
      if (domainBuckets(buckets, NL_BUCKET_KEYS).length) nl = true;
      if (domainBuckets(buckets, ["calc"]).length) calc = true;
      if (domainBuckets(buckets, PALETTE_BUCKET_KEYS).length) palette = true;
      if (domainBuckets(buckets, NARRATIVE_BUCKET_KEYS).length) narrative = true;
      if (domainBuckets(buckets, FLOW_PLAN_BUCKET_KEYS).length) flowPlan = true;
      if (domainBuckets(buckets, ANSWER_BUCKET_KEYS).length) answer = true;
    });
    // The intent score has its own column only where no visualization or
    // calculation column already lists it.
    const intent = match && !viz && !calc;
    return { viz, nl, calc, palette, narrative, flowPlan, answer, intent };
  }, [rowBuckets]);

  // Inline score-breakdown expansion, keyed "<rowKey>:<domain>" so the
  // button in a score column's header can drive every cell of the column.
  const [openScores, setOpenScores] = useState<Set<string>>(new Set());
  // The score columns whose breakdowns were opened with "Expand all".
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(new Set());
  const toggleScore = (key: string) => {
    const next = new Set(openScores);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenScores(next);
    // The last open breakdown of a column closed by hand: its header button
    // is "Expand all" again, and stays so when a row is next opened.
    const domain = key.slice(key.lastIndexOf(":") + 1);
    if (expandedColumns.has(domain) && !Array.from(next).some((k) => k.endsWith(`:${domain}`))) {
      setExpandedColumns((prev) => {
        const cols = new Set(prev);
        cols.delete(domain);
        return cols;
      });
    }
  };
  /**
   * A score column's header: its title, then one button that opens the
   * score breakdown of every test case in the column, or closes them once
   * they are all open.
   */
  const scoreColumnTitle = (title: React.ReactNode, domain: keyof typeof SCORE_COLUMN_BUCKETS) => {
    const keys = state.rows
      .filter((r) => domainBuckets(rowBuckets.get(r.key) || [], SCORE_COLUMN_BUCKETS[domain]).length > 0)
      .map((r) => `${r.key}:${domain}`);
    const openCount = keys.filter((k) => openScores.has(k)).length;
    // After "Expand all" the button stays "Collapse all" while any breakdown
    // of the column is still open: closing one row by hand does not turn it
    // back. Opening rows by hand does not make it "Collapse all" until they
    // are all open.
    const collapse = openCount > 0 && (expandedColumns.has(domain) || openCount === keys.length);
    const name = collapse ? "Collapse All" : "Expand All";
    const tip = !keys.length
      ? "No test case has scores yet"
      : collapse
      ? "Hide the score breakdown of every test case in this column"
      : "Show the score breakdown of every test case in this column";
    return (
      <span className="th-with-action">
        <span>{title}</span>
        <Tooltip title={<><strong>{name}</strong>: {tip}</>}>
          <button
            type="button"
            className="th-action"
            aria-label={name}
            aria-expanded={collapse}
            disabled={!keys.length}
            onClick={() => {
              setExpandedColumns((prev) => {
                const next = new Set(prev);
                if (collapse) next.delete(domain);
                else next.add(domain);
                return next;
              });
              setOpenScores((prev) => {
                const next = new Set(prev);
                keys.forEach((k) => (collapse ? next.delete(k) : next.add(k)));
                return next;
              });
            }}
          >
            {collapse ? <CollapseAllOutlined /> : <ExpandAllOutlined />}
          </button>
        </Tooltip>
      </span>
    );
  };

  // The datasets that can be opened from the Datasource column, and the
  // one open in the side panel.
  const datasets = useDatasets();
  const [openDataset, setOpenDataset] = useState<string | null>(null);
  const [openDashboard, setOpenDashboard] = useState<DashboardRef | null>(null);
  /** Descriptive names for the dashboards of a Dashboard Narratives run (a
   *  case's info.title), by case id; the dashboard's own sheet name stands in
   *  when a case has none or the server predates the endpoint. */
  const [dashboardTitles, setDashboardTitles] = useState<Record<string, { name: string; title: string }>>({});
  // Sort dropdown (UX mock) instead of per-column sorters.
  const [sortBy, setSortBy] = useState<string>("index");
  // Suite tabs share one table, but each run keeps its own page when revisited.
  const [pagesByRun, setPagesByRun] = useState<Record<string, number>>({});
  // Word-level formula diff (classic Show Diff), calc rows only.
  const [diffMode, setDiffMode] = useState(false);
  // Runner names and the in-process bridge address are implementation
  // detail: shown in developer mode.
  const devMode = useMemo(() => isDevMode(), []);
  // Result Summary | runner tabs; land on the runner tab (the mock's focus).
  // In feature mode the summary — the capability cards — is the landing tab.
  const [activeTab, setActiveTab] = useState<string>(featureMode ? "summary" : "runner");
  // A link can name the tab: a suite's own tab, or the Result Summary (the
  // home page's link to a full evaluation). A run with no summary tab falls
  // back to its only tab.
  useEffect(() => {
    if (wantedTab === "runner" || wantedTab === "summary") setActiveTab(wantedTab);
  }, [jobId, wantedTab]);
  // Feature mode: a capability chip for an untested capability lands on its
  // tab, which has no run behind it, so it is a local tab rather than a job.
  useEffect(() => {
    if (!featureMode || !membersLoaded || !wantedCapability) return;
    const m = members.find((x) => x.cat.key === wantedCapability);
    if (m && !m.run) setActiveTab(`cat-${m.cat.key}`);
  }, [featureMode, membersLoaded, wantedCapability, members]);

  // Unique datasources for filter dropdown
  const datasources = useMemo(() => {
    const set = new Set<string>();
    state.rows.forEach((r) => {
      if (r.datasource && r.datasource !== "None") set.add(r.datasource);
    });
    return Array.from(set).sort();
  }, [state.rows]);

  // Rows in dropdown-selected order (UX mock: Sort By dropdown, not
  // per-column sorters).
  /**
   * Order the tab strip: Result Summary, then one tab per suite in launch
   * order. The suite being viewed keeps its own slot, so the strip looks
   * identical no matter which suite you are on.
   */
  const orderTabs = (items: any[]) => {
    if (featureMode) {
      // Capability order, whether or not a capability has a run yet.
      const positionOf = (key: string) => {
        if (key.startsWith("cat-")) return members.findIndex((m) => m.cat.key === key.slice(4));
        const id = key === "runner" ? jobId : key.replace(/^sib-/, "");
        const i = members.findIndex((m) => m.run?.job_id === id);
        return i < 0 ? members.length : i;
      };
      const summary = items.filter((it) => it.key === "summary");
      const rest = items
        .filter((it) => it.key !== "summary")
        .sort((a, b) => positionOf(a.key) - positionOf(b.key));
      return [...summary, ...rest];
    }
    if (siblings.length < 2) return items;
    const positionOf = (key: string) => {
      const id = key === "runner" ? jobId : key.replace(/^sib-/, "");
      const i = siblings.findIndex((sib) => sib.job_id === id);
      return i < 0 ? siblings.length : i;
    };
    const summary = items.filter((it) => it.key === "summary");
    const rest = items
      .filter((it) => it.key !== "summary")
      .sort((a, b) => positionOf(a.key) - positionOf(b.key));
    return [...summary, ...rest];
  };

  /** Conversation key for a row: the part before the ":<turn>" suffix. */
  const convKeyOf = (r: NlqEvalTableRow) => (r.test_case_id || r.key || "").split(":")[0];

  /** conversation key -> its turns, in turn order. */
  const turnsByConversation = useMemo(() => {
    const map = new Map<string, NlqEvalTableRow[]>();
    for (const r of state.rows) {
      const k = convKeyOf(r);
      const list = map.get(k) || [];
      list.push(r);
      map.set(k, list);
    }
    map.forEach((list) => {
      list.sort((a, b) => {
        const ta = parseInt((a.test_case_id || "").split(":")[1] || "0", 10);
        const tb = parseInt((b.test_case_id || "").split(":")[1] || "0", 10);
        return ta - tb;
      });
    });
    return map;
  }, [state.rows]);

  /** Each row's place in its conversation, for the turn label under the
   *  utterance and the boundary drawn around a multi-turn conversation. */
  const turnInfo = useMemo(() => {
    const info = new Map<string, { turn: number; of: number }>();
    turnsByConversation.forEach((turns) => {
      turns.forEach((t, i) => info.set(t.key, { turn: i + 1, of: turns.length }));
    });
    return info;
  }, [turnsByConversation]);
  /** How many test cases the suite has on this page, before any search or
   *  filter. Every turn of a conversation is a test case with its own row. */
  const caseCount = state.rows.length;
  /** A Dashboard Narratives run: its cases are dashboards, not questions. */
  const isDashboardSuite = useMemo(
    () => state.rows.some((r) => r.runner === "dashboard-viz-narrative-config"),
    [state.rows],
  );
  useEffect(() => {
    setDashboardTitles({});
    if (!isDashboardSuite || !jobId) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/nlq-eval/dashboards/${encodeURIComponent(jobId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        // An older server answers an unknown address with the page itself
        // (HTTP 200, HTML): only take a body of the expected shape.
        const map = body && typeof body === "object" && body.dashboards && typeof body.dashboards === "object"
          ? (body.dashboards as Record<string, { name: string; title: string }>)
          : {};
        if (!cancelled) setDashboardTitles(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isDashboardSuite, jobId]);
  /** The name shown for a Dashboard Narratives row: the case's descriptive
   *  title when known, else the dashboard's own name. */
  const dashboardLabel = useCallback(
    (row: NlqEvalTableRow | undefined): string =>
      (row && dashboardTitles[row.test_case_id]?.title) || dashboardNameOf(row?.utterance),
    [dashboardTitles],
  );
  /** Cases the server did not answer the first time, being asked again. */
  const retryingCount = useMemo(() => state.rows.filter((r) => r.pending && r.retrying).length, [state.rows]);
  const retryNote = retryingCount
    ? ` · asking again for ${retryingCount} the server did not answer the first time`
    : "";

  /** The conversations a search or filter leaves, in suite order. A
   *  conversation stays whole when any of its turns matches: a follow-up
   *  question means little without the turns before it. */
  const filteredConversations = useMemo(() => {
    const lower = searchText.trim().toLowerCase();
    const matches = (r: NlqEvalTableRow) =>
      (!lower ||
        Boolean(r.utterance?.toLowerCase().includes(lower)) ||
        Boolean(isDashboardSuite && dashboardLabel(r).toLowerCase().includes(lower)) ||
        Boolean(r.test_case_id?.toLowerCase().includes(lower)) ||
        Boolean(r.datasource?.toLowerCase().includes(lower))) &&
      (!datasourceFilter || r.datasource === datasourceFilter);
    const seen = new Set<string>();
    const out: NlqEvalTableRow[][] = [];
    for (const r of state.rows) {
      const k = convKeyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      const turns = turnsByConversation.get(k) || [r];
      if (turns.some(matches)) out.push(turns);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rows, turnsByConversation, searchText, datasourceFilter, isDashboardSuite, dashboardLabel]);

  /** The table's rows: conversations in the chosen order, each with its
   *  turns kept together and in turn order. */
  const sortedRows = useMemo(() => {
    const conversations = [...filteredConversations];
    // Lowest score first, by a conversation's weakest turn; one with no
    // score for the column (not run yet, or nothing to score) goes last
    // instead of posing as the worst.
    const byScore = (keys: string[]) => {
      const worst = (turns: NlqEvalTableRow[]) => {
        const scores = turns
          .map((r) => bucketOverall(domainBuckets(rowBuckets.get(r.key) || [], keys)))
          .filter((v): v is number => v != null);
        return scores.length ? Math.min(...scores) : null;
      };
      const keyed = conversations.map((turns) => ({ turns, score: worst(turns) }));
      keyed.sort((a, b) => {
        if (a.score == null || b.score == null) return (a.score == null ? 1 : 0) - (b.score == null ? 1 : 0);
        return a.score - b.score;
      });
      keyed.forEach((k, i) => { conversations[i] = k.turns; });
    };
    const byHighest = (weight: (r: NlqEvalTableRow) => number) => {
      const top = (turns: NlqEvalTableRow[]) => Math.max(...turns.map(weight));
      conversations.sort((a, b) => top(b) - top(a));
    };
    if (sortBy === "name") {
      conversations.sort((a, b) =>
        dashboardLabel(a[0]).localeCompare(dashboardLabel(b[0]), undefined, { sensitivity: "base" }),
      );
    } else if (sortBy === "latency") {
      byHighest((r) => r.latency ?? -1);
    } else if (sortBy === "viz") {
      byScore(VIZ_OVERALL_KEYS);
    } else if (sortBy === "nl") {
      byScore(NL_BUCKET_KEYS);
    } else if (sortBy === "calc") {
      byScore(["calc"]);
    } else if (sortBy === "palette") {
      byScore(PALETTE_BUCKET_KEYS);
    } else if (sortBy === "narrative") {
      byScore(NARRATIVE_BUCKET_KEYS);
    } else if (sortBy === "flowPlan") {
      byScore(FLOW_PLAN_BUCKET_KEYS);
    } else if (sortBy === "intent") {
      byScore(INTENT_BUCKET_KEYS);
    } else if (sortBy === "answer") {
      byScore(ANSWER_BUCKET_KEYS);
    } else if (sortBy === "errors") {
      byHighest((r) => r.errors.filter((e) => !e.is_warning).length * 1000 + r.errors.length);
    }
    return conversations.flat();
  }, [filteredConversations, sortBy, rowBuckets, dashboardLabel]);

  /** Expected/Actual cell: chart preview and the reply as a speech bubble. */
  /** "Run", "Prepare", "Judge"…: the phase the row's first real error came from. */
  const errorPhaseWord = (errors: NlqEvalTableRow["errors"]): string => {
    const first = errors.find((e) => !e.is_warning) || errors[0];
    const phase = String(first?.phase || "").toLowerCase();
    if (!phase) return "Error";
    if (phase.includes("run")) return "Run";
    if (phase.includes("prep")) return "Prepare";
    if (phase.includes("judge") || phase.includes("eval")) return "Evaluator";
    return phase.charAt(0).toUpperCase() + phase.slice(1);
  };

  const responseCell = (row: NlqEvalTableRow, which: "expected" | "actual") => {
    if (which === "actual" && row.pending) {
      // Only the cases the run is working on right now are running; the
      // rest of the unfinished ones are waiting their turn, or, on a paused
      // run, waiting for it to be resumed.
      return row.running ? (
        <Text type="secondary">
          <LoadingOutlined style={{ marginRight: 6 }} />
          {row.retrying ? "Running again…" : "Running…"}
        </Text>
      ) : row.retrying && state.run?.status !== "paused" ? (
        <Tooltip title="Asked again because the server did not answer the first time">
          <Text type="secondary">
            <ClockCircleOutlined style={{ marginRight: 6 }} />
            Queued to run again
          </Text>
        </Tooltip>
      ) : state.run?.status === "paused" ? (
        <Text type="secondary">
          <PauseOutlined style={{ marginRight: 6 }} />
          Paused
        </Text>
      ) : (
        <Text type="secondary">
          <ClockCircleOutlined style={{ marginRight: 6 }} />
          Queued
        </Text>
      );
    }
    const out = which === "expected" ? row.expected : row.actual;
    // A follow-up the model answered without a chart leaves the previous
    // chart on screen; the run records that chart, and the scores compare it.
    const unchangedChart =
      which === "actual" && !out?.notionalSpec && (out as any)?.unchanged_chart && typeof (out as any).unchanged_chart === "object"
        ? (out as any).unchanged_chart
        : null;
    const spec = out?.notionalSpec ?? unchangedChart;
    const rawPalette = (out as any)?.colorPalette;
    const palette = Array.isArray(rawPalette)
      ? rawPalette.filter((c: unknown): c is string => typeof c === "string")
      : null;
    const narrative =
      typeof (out as any)?.insightNarrative === "string" &&
      (out as any).insightNarrative.trim()
        ? ((out as any).insightNarrative as string)
        : null;
    // Calc runners: calculatedFieldFormula.formula (classic path), with the
    // bare `calculation` field as a fallback shape.
    const formula: string | null =
      (out as any)?.calculatedFieldFormula?.formula ??
      (typeof (out as any)?.calculation === "string"
        ? (out as any).calculation
        : null);
    const expFormula: string | null =
      (row.expected as any)?.calculatedFieldFormula?.formula ??
      (typeof (row.expected as any)?.calculation === "string"
        ? (row.expected as any).calculation
        : null);
    const actFormula: string | null =
      (row.actual as any)?.calculatedFieldFormula?.formula ??
      (typeof (row.actual as any)?.calculation === "string"
        ? (row.actual as any).calculation
        : null);
    const calcDebug =
      which === "actual" && formula ? parseCalcDebug(row.debug_info) : {};
    const calcName =
      which === "actual"
        ? (row.actual as any)?.calculatedFieldFormula?.caption || calcDebug.calcName
        : null;
    // Tableau Prep "Plan a flow": the answer is a list of steps.
    const planSteps = flowPlanSteps((out as any)?.flowPlan);
    const reply =
      which === "actual"
        ? (row.actual as any)?.user_friendly_reply ||
          calcDebug.explanation ||
          (typeof (row.actual as any)?.flowPlan?.userFriendlyExplanation === "string"
            ? (row.actual as any).flowPlan.userFriendlyExplanation
            : null) ||
          extractNlReply(row.debug_info)
        : (row.expected as any)?.user_friendly_reply ||
          (row.expected as any)?.userFriendlyReply;
    // Tableau Prep "Understand the request": the answer is the kind of
    // request, one word. Chart and calculation cases carry an intent beside
    // their real answer; it is shown only when it is the whole answer.
    const hasOtherAnswer = Boolean(
      spec || narrative || formula || (palette && palette.length) || planSteps,
    );
    const intent: string | null =
      !hasOtherAnswer && typeof (out as any)?.intent === "string" && (out as any).intent.trim()
        ? (out as any).intent.trim()
        : null;
    // A chart case whose expected chart is missing from the suite: say so,
    // since that is why the case has no chart scores.
    if (
      which === "expected" &&
      out && typeof out === "object" && "notionalSpec" in (out as any) &&
      !spec && !formula
    ) {
      return (
        <Tooltip title="The suite ships this test case without an expected chart, so the model's chart is not scored. The request type and the evaluator model's view of the reply are.">
          <Text type="secondary" style={{ cursor: "help" }}>
            No expected chart in this suite. Not scored on the chart.
          </Text>
        </Tooltip>
      );
    }
    // An answer the suite could not read (not the format it asks for): the
    // model did reply, and the reply is shown as it came. A Prep intent
    // row that was read (older runs stored the word twice) has no raw reply
    // to show.
    const rawReply: string | null =
      which === "actual" && !intent && typeof (row.actual as any)?.raw_reply === "string"
        ? (row.actual as any).raw_reply
        : null;
    // Why a Prep flow-plan case has words instead of a plan, when the
    // runner said (runs since 2026-10-15).
    const rawReplyNote =
      (row.actual as any)?.no_plan === "question"
        ? "The model asked a question instead of planning"
        : (row.actual as any)?.no_plan === "decline"
          ? "The model declined instead of planning"
          : (row.actual as any)?.no_plan === "words"
            ? "The model answered in words, not with a plan"
            : "Not in the expected format";
    if (!hasOtherAnswer && !reply && !intent && !rawReply) {
      if (which !== "actual") {
        // A palette case with no expected colors: say so, since that is
        // why it has no Ground Truth Match score.
        if (Array.isArray(rawPalette)) {
          return (
            <Tooltip title="More than one palette can be right for this request, so there is no Ground Truth Match score for it">
              <Text type="secondary" style={{ cursor: "help" }}>
                No single expected palette. Scored on structure, distinctness and design.
              </Text>
            </Tooltip>
          );
        }
        return <Text type="secondary">—</Text>;
      }
      // Say why there is nothing here. The server's error text already
      // carries what a 401 or 403 means; a finished case with no error and
      // no content is the model answering with nothing, which is a
      // different problem (bug bash 2026-09-23: three "No response" rows
      // with no explanation).
      const realErrors = row.errors.filter((e) => !e.is_warning);
      if (realErrors.length > 0) {
        const errorText =
          (realErrors[0].description || "Unknown error") +
          (realErrors.length > 1 ? ` (+${realErrors.length - 1} more, hover the Error column)` : "");
        return (
          <div>
            <Text strong style={{ color: SCORE_COLORS.low.color }}>No answer</Text>
            <Paragraph
              type="secondary"
              style={{ margin: "4px 0 0", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              // A short message fits in three rows, so Show More would reveal
              // nothing (antd's overflow check can still offer it).
              ellipsis={
                errorText.length > SHORT_ERROR_CHARS
                  ? { rows: 3, expandable: true, symbol: "Show More" }
                  : undefined
              }
            >
              {errorText}
            </Paragraph>
          </div>
        );
      }
      return (
        <Text style={{ color: SCORE_COLORS.medium.color }}>Empty answer from the model</Text>
      );
    }
    const showDiff = diffMode && expFormula && actFormula;
    return (
      <div style={{ maxWidth: 280 }}>
        {unchangedChart && (
          <Tooltip title={UNCHANGED_CHART_NOTE}>
            <Text type="secondary" style={{ display: "block", fontSize: 12, cursor: "help", marginBottom: 2 }}>
              Unchanged from the previous turn
            </Text>
          </Tooltip>
        )}
        {spec && (
          <LazyChartPreview width={246} height={110}>
            <NotionalSpecChart spec={spec} width={246} height={110} />
          </LazyChartPreview>
        )}
        {which === "expected" && !reply && typeof row.info?.expected_description === "string" && (
          // What Information Similarity compares the model's reply to when
          // the case has no written expected reply (bug bash 2026-10-23, item 17).
          <div style={{ marginTop: 6 }}>
            <Tooltip title="The case ships no written expected reply, so the tool describes the expected chart in words; Information Similarity compares the model's reply to this.">
              <Text type="secondary" style={{ display: "block", fontSize: 11, cursor: "help", marginBottom: 2 }}>
                Expected description, from the expected chart
              </Text>
            </Tooltip>
            <ReplyBubble text={row.info.expected_description} />
          </div>
        )}
        {palette && palette.length > 0 && <PaletteSwatches colors={palette} />}
        {narrative && <NarrativeBlock text={narrative} />}
        {planSteps && <FlowPlanSteps steps={planSteps} />}
        {intent && (
          <Tooltip title={intentNote(intent, which)}>
            <span
              style={{
                display: "inline-block",
                fontSize: 12,
                background: "#fafafa",
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: "2px 8px",
                cursor: "help",
              }}
            >
              {intentChipText(intent, which)}
            </span>
          </Tooltip>
        )}
        {rawReply && (
          <div>
            <Text style={{ color: SCORE_COLORS.medium.color }}>{rawReplyNote}</Text>
            <div style={{ marginTop: 6 }}>
              <ReplyBubble text={rawReply} />
            </div>
          </div>
        )}
        {formula && (
          <FormulaBox>
            {showDiff ? (
              <DiffText segs={computeDiff(expFormula!, actFormula!)} side={which} />
            ) : (
              formula
            )}
          </FormulaBox>
        )}
        {calcName && (
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <Text type="secondary">Calculation name: </Text>
            <Text strong>{calcName}</Text>
          </div>
        )}
        {reply && (
          <div style={{ marginTop: 6 }}>
            <ReplyBubble text={reply} />
          </div>
        )}
        {which === "expected" && row.info?.ground_truth && typeof row.info.ground_truth === "object" && (
          // Questions about a dashboard: how the expected answer was computed
          // from the shipped sample data (bug bash 2026-10-23).
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: "ground-truth",
                label: (
                  <Text type="secondary" style={{ fontSize: 12 }}>How the expected answer was computed</Text>
                ),
                children: (
                  <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                    {row.info.ground_truth.datasource && (
                      <div>
                        <Text type="secondary">Data source: </Text>
                        <Text>{String(row.info.ground_truth.datasource)}</Text>
                        {row.datasource && (
                          <>
                            {" "}
                            <button type="button" className="cell-link" onClick={() => setOpenDataset(row.datasource!)}>
                              fields and first rows
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {row.info.ground_truth.sql && (
                      <div style={{ marginTop: 4 }}>
                        <Text type="secondary">Computed with: </Text>
                        <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, background: "#fbfbfd", border: "1px solid #e5e5ea", borderRadius: 6, padding: "6px 8px" }}>
                          {String(row.info.ground_truth.sql)}
                        </pre>
                      </div>
                    )}
                    {row.info.ground_truth.expect !== undefined && (
                      <div style={{ marginTop: 4 }}>
                        <Text type="secondary">Result: </Text>
                        <Text strong>{String(row.info.ground_truth.expect)}</Text>
                      </div>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
        {which === "actual" && calcDebug.reasoning && (
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: "reasoning",
                label: (
                  <Text type="secondary" style={{ fontSize: 12 }}>Model Reasoning</Text>
                ),
                children: (
                  <div
                    style={{
                      fontSize: 11,
                      lineHeight: 1.55,
                      maxHeight: 180,
                      overflowY: "auto",
                      whiteSpace: "pre-wrap",
                      background: "#fbfbfd",
                      border: "1px solid #e5e5ea",
                      borderRadius: 6,
                      padding: "6px 8px",
                    }}
                  >
                    {calcDebug.reasoning}
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>
    );
  };

  // A chart preview (Build a visualization) needs its 260px; text columns
  // get by on less and grow when the window allows.
  const responseColumnWidth = domainPresence.viz ? 270 : 200;
  const columns: ColumnsType<NlqEvalTableRow> = [
    {
      title: "Row",
      key: "index",
      width: 44,
      render: (_: any, __: NlqEvalTableRow, index: number) => (
        <Text type="secondary">{index + 1}</Text>
      ),
    },
    // Suites that ask about no dataset (Color palettes) have no Datasource
    // column, and no datasource filter above the table.
    ...(datasources.length === 0 ? [] : ([{
      title: "Data source",
      dataIndex: "datasource",
      key: "datasource",
      width: 110,
      // The name wraps rather than being cut off; runners without a
      // datasource concept serialize the literal "None", and older Prep
      // runs stored the bench's "SKIP" (no flow file) as the name.
      render: (val: string | null) => {
        if (!val || val === "None" || val === "SKIP") return <Text type="secondary">—</Text>;
        // A dataset of the test content opens in a side panel. Older Prep
        // runs stored a data file's path inside the bench; the file's name
        // is what the panel knows it by.
        const dataset = datasets[val] || datasets[val.split("/").pop() || val];
        return dataset ? (
          <Tooltip title="See what this data source holds and its fields">
            <button type="button" className="cell-link" onClick={() => setOpenDataset(dataset.id)}>
              {dataset.name}
            </button>
          </Tooltip>
        ) : (
          <span style={{ overflowWrap: "anywhere" }}>{val}</span>
        );
      },
    }] as ColumnsType<NlqEvalTableRow>)),
    {
      title: isDashboardSuite ? "Dashboard name" : "User request",
      dataIndex: "utterance",
      key: "utterance",
      width: 160,
      flex: true,
      // Classic idiom: the user's ask reads as a chat bubble. A turn of a
      // multi-turn conversation says which turn it is under the bubble.
      render: (val: string, row: NlqEvalTableRow) => {
        // A Dashboard Narratives case has no question: it is about one
        // dashboard, named here the way a datasource is, and the name opens
        // the dashboard in a side panel.
        if (isDashboardSuite) {
          const sheet = dashboardNameOf(val);
          const name = dashboardLabel(row);
          if (!name) return <Text type="secondary">—</Text>;
          // The descriptive name, with the dashboard's own sheet name under
          // it when that says something different ("Home", "main page").
          const sheetNote = sheet && sheet !== name ? (
            <div><Text type="secondary" style={{ fontSize: 12 }}>{sheet}</Text></div>
          ) : null;
          return jobId ? (
            <>
              <Tooltip title={`See the dashboard ${name}`}>
                <button
                  type="button"
                  className="cell-link"
                  onClick={() => setOpenDashboard({ jobId, caseId: row.test_case_id, name })}
                >
                  {name}
                </button>
              </Tooltip>
              {sheetNote}
            </>
          ) : (
            <>
              <span style={{ overflowWrap: "anywhere" }}>{name}</span>
              {sheetNote}
            </>
          );
        }
        const turn = turnInfo.get(row.key);
        return (
          <>
            {val ? <SpeechBubble variant="user">{val}</SpeechBubble> : null}
            {turn && turn.of > 1 && (
              <div className="turn-label">{`Turn ${turn.turn} of ${turn.of}`}</div>
            )}
          </>
        );
      },
    },
    {
      title: "Expected response",
      key: "expected",
      width: responseColumnWidth,
      flex: true,
      render: (_: any, row: NlqEvalTableRow) => responseCell(row, "expected"),
    },
    {
      title: domainPresence.calc ? (
        <span className="th-with-action">
          <span>Actual response</span>
          <Tooltip title={
            <>
              <strong>{diffMode ? "Hide diff" : "Show diff"}</strong>:{" "}
              {diffMode
                ? "Show the formulas as plain text again"
                : "Mark where each formula differs from the expected one, missing parts in the Expected column and added parts in this one"}
            </>
          }>
            <button
              type="button"
              className={`th-action${diffMode ? " th-action-on" : ""}`}
              aria-label={diffMode ? "Hide diff" : "Show diff"}
              aria-pressed={diffMode}
              onClick={() => setDiffMode(!diffMode)}
            >
              <DiffOutlined />
            </button>
          </Tooltip>
        </span>
      ) : "Actual response",
      key: "actual",
      label: "Actual response",
      width: responseColumnWidth,
      flex: true,
      render: (_: any, row: NlqEvalTableRow) => responseCell(row, "actual"),
    },
    ...(domainPresence.viz
      ? ([
          {
            title: scoreColumnTitle("Visualization quality", "viz"),
            key: "vizScore",
            label: "Visualization quality",
            width: WIDE_SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], VIZ_BUCKET_KEYS)}
                overallKeys={VIZ_OVERALL_KEYS}
                open={openScores.has(`${row.key}:viz`)}
                onToggle={() => toggleScore(`${row.key}:viz`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    ...(domainPresence.nl
      ? ([
          {
            title: scoreColumnTitle(
              <>
                <JudgeTag />
                Natural language quality
              </>,
              "nl",
            ),
            key: "nlScore",
            label: "Natural language quality",
            width: WIDE_SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], NL_BUCKET_KEYS)}
                open={openScores.has(`${row.key}:nl`)}
                onToggle={() => toggleScore(`${row.key}:nl`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    ...(domainPresence.calc
      ? ([
          {
            title: scoreColumnTitle(sentenceCase(categoryLabel("calc", capability)), "calc"),
            key: "calcScore",
            label: sentenceCase(categoryLabel("calc", capability)),
            width: SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], CALC_BUCKET_KEYS)}
                overallKeys={["calc"]}
                open={openScores.has(`${row.key}:calc`)}
                onToggle={() => toggleScore(`${row.key}:calc`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    ...(domainPresence.palette
      ? ([
          {
            title: scoreColumnTitle("Palette quality", "palette"),
            key: "paletteScore",
            label: "Palette quality",
            width: SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], PALETTE_BUCKET_KEYS)}
                open={openScores.has(`${row.key}:palette`)}
                onToggle={() => toggleScore(`${row.key}:palette`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    ...(domainPresence.narrative
      ? ([
          {
            title: scoreColumnTitle("Narrative quality", "narrative"),
            key: "narrativeScore",
            label: "Narrative quality",
            width: SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], NARRATIVE_BUCKET_KEYS)}
                open={openScores.has(`${row.key}:narrative`)}
                onToggle={() => toggleScore(`${row.key}:narrative`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    ...(domainPresence.intent
      ? ([
          {
            title: scoreColumnTitle("Intent and spec", "intent"),
            key: "intentScore",
            label: "Intent and spec",
            width: SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], INTENT_BUCKET_KEYS)}
                open={openScores.has(`${row.key}:intent`)}
                onToggle={() => toggleScore(`${row.key}:intent`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    ...(domainPresence.flowPlan
      ? ([
          {
            title: scoreColumnTitle("Flow plan quality", "flowPlan"),
            key: "flowPlanScore",
            label: "Flow plan quality",
            width: SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], FLOW_PLAN_BUCKET_KEYS)}
                open={openScores.has(`${row.key}:flowPlan`)}
                onToggle={() => toggleScore(`${row.key}:flowPlan`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    ...(domainPresence.answer
      ? ([
          {
            title: scoreColumnTitle(
              <>
                <JudgeTag />
                Answer quality
              </>,
              "answer",
            ),
            key: "answerScore",
            label: "Answer quality",
            width: SCORE_COLUMN_WIDTH,
            flex: true,
            render: (_: any, row: NlqEvalTableRow) => (
              <RowScoreCell
                buckets={domainBuckets(rowBuckets.get(row.key) || [], ANSWER_BUCKET_KEYS)}
                open={openScores.has(`${row.key}:answer`)}
                onToggle={() => toggleScore(`${row.key}:answer`)}
              />
            ),
          },
        ] as ColumnsType<NlqEvalTableRow>)
      : []),
    {
      title: "Latency",
      dataIndex: "latency",
      key: "latency",
      width: 72,
      align: "right",
      // Pinned, with Error: the table is wider than most windows, and these
      // two were the columns that ended up cut off at its right edge.
      fixed: "right",
      render: (val: number | null) => (
        <Text type="secondary">{latencyDisplay(val)}</Text>
      ),
    },
    {
      title: "Error",
      key: "errors",
      width: 60,
      align: "center",
      fixed: "right",
      render: (_: any, row: NlqEvalTableRow) => {
        if (row.errors.length === 0) return <Text type="secondary">0</Text>;
        const warningsOnly = row.errors.every((e) => e.is_warning);
        return (
          <Tooltip
            overlayStyle={{ maxWidth: 440 }}
            title={
              <div>
                {row.errors.map((e, i) => (
                  <div key={i}>
                    {e.is_warning ? "Warning" : "Error"}: {e.description || "Unknown error"}
                  </div>
                ))}
              </div>
            }
          >
            <Text
              style={{
                color: warningsOnly ? SCORE_COLORS.medium.color : SCORE_COLORS.low.color,
                fontWeight: 600,
                cursor: "help",
                fontSize: 12,
              }}
            >
              {errorPhaseWord(row.errors)} {row.errors.length}
            </Text>
          </Tooltip>
        );
      },
    },
  ];

  // The columns as the admin arranged them, and the ones on show.
  const arrangedColumns = arrangeColumns(columns, columnSettings.order);
  const hiddenColumns = new Set(columnSettings.hidden);
  const shownColumns = arrangedColumns.filter((c) => !hiddenColumns.has(String(c.key)));
  const movableKeys = () => arrangedColumns.filter((c) => c.fixed !== "right").map((c) => String(c.key));
  const moveColumn = (fromKey: string, toKey: string) => {
    const keys = movableKeys();
    const from = keys.indexOf(fromKey);
    const to = keys.indexOf(toKey);
    if (from < 0 || to < 0 || from === to) return;
    keys.splice(from, 1);
    keys.splice(to, 0, fromKey);
    updateColumnSettings({ ...columnSettings, order: keys });
  };
  const stepColumn = (key: string, direction: -1 | 1) => {
    const keys = movableKeys();
    const at = keys.indexOf(key);
    if (at < 0 || at + direction < 0 || at + direction >= keys.length) return;
    moveColumn(key, keys[at + direction]);
  };
  const toggleColumn = (key: string) => {
    if (LOCKED_COLUMNS.has(key)) return;
    const hidden = hiddenColumns.has(key)
      ? columnSettings.hidden.filter((k) => k !== key)
      : [...columnSettings.hidden, key];
    updateColumnSettings({ ...columnSettings, hidden });
  };
  const columnsChanged = columnSettings.order.length > 0 || columnSettings.hidden.length > 0;
  // What the legend above the table says: the suite's own ranges when its
  // capability has a baseline (every pill of the run is coloured against
  // it); the 33 / 66 bands otherwise.
  const tableBaseline = capabilityBaseline(capability) ?? null;

  /**
   * Feature mode: one card per capability. The headline is the latest
   * COMPLETE run's score; a run that is still going, paused or queued is a
   * status chip beside it, never a replacement for it (UX-13). A capability
   * with no run says so and offers to start one; a past run can be chosen
   * from the card and is shown in that capability's tab.
   */
  const memberCards = featureMode ? (
    <div style={{ marginBottom: 20 }}>
      <div className="heading-with-legend">
        <Text strong>Capabilities</Text>
        <BaselineLegend />
      </div>
      <div className="capability-cards">
        {members.map((m) => {
          const shown = m.run;
          const shownStatus = shown
            ? runStatusInfo(shown.status, {
                neverStarted: shown.never_started,
                failedCases: shown.failed_cases,
                total: shown.total,
              })
            : null;
          const isCurrent = Boolean(shown && shown.job_id === jobId);
          const isPast = Boolean(shown && m.history[0] && shown.job_id !== m.history[0].job_id);
          // Several suites of this capability launched together (Evaluate all
          // on Questions about a dashboard) are one evaluation: the card
          // lists them, with the mean of their main measure, and the tab
          // shows the one chosen (decision of 2026-10-19).
          const batchMates = shown && shown.batch_id
            ? m.history
                .filter((r) => r.batch_id === shown.batch_id)
                .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
            : [];
          const batchHeadline = batchMates.length > 1 ? evaluationHeadlineScores(batchMates)[0] : undefined;
          const batchStatusWord = batchMates.length > 1 ? evaluationStatus(batchMates) : undefined;
          const inFlight = m.history.some((r) => RUNNING_STATUSES.includes(r.status));
          // Every suite launches directly; a Questions about a dashboard run
          // publishes its own sample content when it starts.
          const canLaunch = Boolean(m.suite?.available && m.suite?.path) && !inFlight;
          const launchTip = connReady === false
            ? launchBlocked
            : m.suite?.server_supported === false
            ? m.suite.server_message
            : inFlight
            ? "This capability is being evaluated right now"
            : m.suite?.coming_soon
            ? "Coming soon — the public tests for this capability are being prepared"
            : !m.suite?.available
            ? "No tests for this capability on this machine"
            : `Runs the public suite (${fmtCount(m.suite?.case_count)} test cases)`;
          const stamp = (r: RunRecord) => String(r.created_at || "").slice(0, 16);
          return (
            <FlexCard
              fill
              key={m.cat.key}
              title={m.cat.label}
              extra={shown && shownStatus ? (
                <Tooltip title={shown.total ? `${fmtCount(shown.completed)} of ${fmtCount(shown.total)} test cases` : undefined}>
                  <Tag color={shownStatus.color} style={{ marginRight: 0 }}>
                    {shown.status === "finished" && !(shown.failed_cases || 0) ? "Completed" : shownStatus.label}
                  </Tag>
                </Tooltip>
              ) : undefined}
            >
              {shown ? (
                <>
                  {isPast && (
                    <div style={{ fontSize: 12, marginBottom: 6 }}>
                      <Text type="warning">Showing the run from {stamp(shown)}</Text>
                    </div>
                  )}
                  {/* A live run shows how far it is; a settled one its numbers.
                      The status itself is the tag in the card header. */}
                  {batchMates.length > 1 && (
                    <div className="batch-suites" style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <Text strong>{batchMates.length} suites in this evaluation</Text>
                        {batchHeadline && batchHeadline.average != null && (
                          <>
                            <Text type="secondary">· {batchHeadline.label}, mean</Text>
                            <ScorePill val={batchHeadline.average} decimals={2} />
                          </>
                        )}
                        {batchStatusWord && batchStatusWord !== "finished" && (
                          <Tag color={runStatusInfo(batchStatusWord).color} style={{ marginRight: 0 }}>{runStatusInfo(batchStatusWord).label}</Tag>
                        )}
                      </div>
                      <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                        {batchMates.map((r) => {
                          const main = (r.headline_scores || []).find((h) => h.average != null);
                          const info = runStatusInfo(r.status, { neverStarted: r.never_started, failedCases: r.failed_cases, total: r.total });
                          const here = r.job_id === shown.job_id;
                          return (
                            <div key={r.job_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                              {here ? (
                                <Text strong>{suiteDisplayName(r.suite_label, r)}</Text>
                              ) : (
                                <RouterLink to={resultsPath(r.job_id)} className="row-link" aria-label={`View Results for ${suiteDisplayName(r.suite_label, r)}`}>
                                  {suiteDisplayName(r.suite_label, r)}
                                </RouterLink>
                              )}
                              <Tooltip title={r.total ? `${fmtCount(r.completed)} of ${fmtCount(r.total)} test cases` : undefined}>
                                <Tag color={info.color} style={{ marginRight: 0 }}>
                                  {r.status === "finished" && !(r.failed_cases || 0) ? "Completed" : info.label}
                                </Tag>
                              </Tooltip>
                              {main && main.average != null && <ScorePill val={main.average} decimals={2} />}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {ACTIVE_STATUSES.includes(shown.status) ? (
                    <SuiteProgress completed={shown.completed || 0} total={shown.total || 0} queued={shown.status === "queued"} />
                  ) : !shown.never_started ? (
                    <SuiteSummaryTiles summary={suiteSummaries[shown.job_id]?.data} ended={shown.status === "finished"} base={baseOf(shown.ai_feature, shown.suite_id)} />
                  ) : null}
                  {/* The home page's row idiom: a labelled link, then icons
                      in fixed slots (pause/resume, cancel). */}
                  <div className="row-actions card-footer">
                    {!isCurrent ? (
                      <RouterLink to={resultsPath(shown.job_id)} className="row-link" aria-label={`View Results for ${m.cat.label}`}>
                        View Results
                      </RouterLink>
                    ) : (
                      <button type="button" className="row-link"
                        onClick={() => setActiveTab("runner")}>
                        View Results
                      </button>
                    )}
                    <span className="row-action-slot">
                      {["started", "running"].includes(shown.status) && (
                        <Tooltip title="Pause">
                          <button type="button" className="row-icon" aria-label="Pause this capability's run"
                            onClick={() => jobAction("pause", "Pause requested", shown.job_id)}>
                          <PauseOutlined />
                        </button>
                      </Tooltip>
                      )}
                      {isResumableRun(shown) && (
                        <Tooltip title="Resume">
                          <button type="button" className="row-icon row-icon-primary" aria-label="Resume this capability's run"
                            onClick={() => jobAction("resume", "Resumed", shown.job_id)}>
                          <CaretRightOutlined />
                        </button>
                      </Tooltip>
                      )}
                    </span>
                    <span className="row-action-slot">
                      {(["started", "running"].includes(shown.status) || isResumableRun(shown)) && (
                        <Tooltip title="Cancel">
                          <Popconfirm
                            title={`Cancel ${m.cat.label}? Completed cases are kept.`}
                            onConfirm={async () => { await jobAction("cancel", "Cancel requested", shown.job_id); }}
                          >
                            <button type="button" className="row-icon row-icon-danger" aria-label="Cancel this capability's run">
                              <StopOutlined />
                            </button>
                          </Popconfirm>
                        </Tooltip>
                      )}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    <Text type="secondary">Not yet tested</Text>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4, maxWidth: 260 }}>
                    <Text type="secondary">
                      {m.suite?.available
                        ? `${m.cat.task} · ${fmtCount(m.suite.case_count)} test cases`
                        : m.suite?.coming_soon
                        ? "Coming soon — the public tests for this capability are being prepared"
                        : "No tests for this capability on this machine"}
                    </Text>
                  </div>
                  {m.suite?.available && (
                    <div style={{ marginTop: 10 }}>
                      <Tooltip title={launchTip}>
                        <Button
                          type="primary"
                          size="small"
                          icon={<CaretRightOutlined />}
                          style={canLaunch && connReady !== false ? { backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR } : undefined}
                          loading={launchingCat === m.cat.key}
                          disabled={!canLaunch || connReady === false || m.suite?.server_supported === false || (launchingCat !== null && launchingCat !== m.cat.key)}
                          onClick={() => launchMember(m)}
                        >
                          Evaluate
                        </Button>
                      </Tooltip>
                    </div>
                  )}
                </>
              )}
            </FlexCard>
          );
        })}
      </div>
    </div>
  ) : null;

  // Loading state. In feature mode with no run at all there is nothing to
  // load: the page shows the capabilities, each waiting to be evaluated.
  const featureEmpty = featureMode && membersLoaded && !jobId;
  if (state.status === "loading" && !state.run && !featureEmpty) {
    return (
      <div style={{ textAlign: "center", padding: 80 }}>
        <LoadingOutlined style={{ fontSize: 32 }} />
        <div style={{ marginTop: 16 }}>Loading results…</div>
      </div>
    );
  }

  // Error state (no results at all)
  if (state.status === "error" && state.rows.length === 0) {
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/")} style={{ marginBottom: 16 }}>
          Back to Evaluations
        </Button>
        <Alert
          type="error"
          showIcon
          message="Can't Load the Results"
          description={state.error}
          style={{ marginBottom: 12 }}
        />
        <Button type="primary" onClick={reload}>Try Again</Button>
      </div>
    );
  }

  if (featureEmpty && featureDefn) {
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/")} style={{ marginBottom: 16 }}>
          Back to Evaluations
        </Button>
        <h1 className="tds-h1">Evaluation Results: {featureDefn.title}</h1>
        <div style={{ margin: "8px 0 20px" }}>
          <Text type="secondary">
            Nothing has been evaluated for this feature yet. Evaluate a capability below, or all
            of them at once from the home page.
          </Text>
        </div>
        {memberCards}
      </div>
    );
  }

  const run = state.run;
  const isStreaming = state.status === "streaming";
  const isPaused = run?.status === "paused";
  const cfg = run?.config || {};
  // ces runs carry no model override by design: the server resolves the
  // model from Site Settings (Viz & Calc generation). If the admin declared
  // which model that setting holds, show it as the declared identity;
  // otherwise fall back to the generic label.
  const model =
    cfg.models?.create ||
    cfg.models?.understand ||
    // Read from Site Settings when the run was launched, so the record names
    // the model rather than the slot it came from.
    cfg.resolved_site_model ||
    // A job that never started has no stored config; the model it was
    // launched against was recorded in its state.
    state.runState?.model_name ||
    (cfg.generations_mode === "ces"
      ? cfg.declared_site_model
        ? `${cfg.declared_site_model} (declared)`
        : "Site Settings model (Perform analytics tasks)"
      : undefined);
  const suite =
    // What the dashboard called it, so the page title matches the row the
    // admin clicked: the runs list carries the suite's CURRENT catalog name
    // (suites were renamed after the capability chips), the run's own config
    // the name at launch; folder names are the fallback for API launches.
    runRecord?.suite_label ||
    cfg.suite_label ||
    state.runState?.suite_label ||
    cfg.test_cases_label ||
    cfg.test_cases_id ||
    (cfg.test_path ? String(cfg.test_path).split("/").filter(Boolean).pop() : null);
  /**
   * The name a customer sees for a suite: its catalog label, else the
   * feature category ("Calculated fields"), never the internal runner id
   * ("ect-server") unless in dev mode. Bug bash 2026-09-23 (Ewald: "What is
   * this ECT server?").
   */
  const suiteDisplayName = (
    label: string | null | undefined,
    runLike: { ai_feature?: string | null; runner_name?: string | null } | null | undefined,
  ): string =>
    label ||
    (runLike ? categoryOfRun(runLike as any).label : "") ||
    (devMode && runLike?.runner_name) ||
    "Results";
  const judgeIdentity = state.runState?.judge_provider
    ? `${providerLabel(state.runState.judge_provider)}${state.runState.judge_model ? ` ${state.runState.judge_model}` : ""}`
    : null;

  // For a batch, the header describes the WHOLE evaluation and stays put as
  // you move between tabs; only the detail below changes. Header controls
  // act on every eligible suite of the evaluation.
  const inBatch = siblings.length > 1;
  const runnerTabName = featureMode
    ? members.find((m) => m.run?.job_id === jobId)?.cat.label || "Results"
    : suiteDisplayName(
        siblings.find((sib) => sib.job_id === jobId)?.suite_label ||
          runRecord?.suite_label ||
          cfg.suite_label ||
          state.runState?.suite_label,
        run,
      );
  const activeSibling =
    siblings.find((sib) => ["started", "running"].includes(sib.status)) ||
    siblings.find((sib) => sib.status === "paused") ||
    siblings.find((sib) => sib.status === "queued") ||
    siblings[siblings.length - 1];
  const batchTotals = siblings.reduce(
    (acc, sib) => ({
      completed: acc.completed + (sib.completed || 0),
      total: acc.total + (sib.total || 0),
      finished: acc.finished + (sib.status === "finished" ? 1 : 0),
      failed: acc.failed + (sib.status === "failed" ? 1 : 0),
      cancelled: acc.cancelled + (sib.status === "cancelled" ? 1 : 0),
    }),
    { completed: 0, total: 0, finished: 0, failed: 0, cancelled: 0 },
  );
  // The batch reads as its most urgent suite: anything still going, then
  // anything waiting on the admin, and only "finished" if every suite was.
  const batchStatusKey = siblings.some((sib) => RUNNING_STATUSES.includes(sib.status))
    ? "running"
    : siblings.some((sib) => sib.status === "paused")
    ? "paused"
    : siblings.some((sib) => sib.status === "queued")
    ? "queued"
    : siblings.some((sib) => sib.status === "failed")
    ? "failed"
    : siblings.every((sib) => sib.status === "cancelled")
    ? "cancelled"
    : "finished";
  const batchStatus = runStatusInfo(batchStatusKey);
  // Every state present in the batch, as counts: "1 running · 2 queued ·
  // 1 finished" says what is waiting, where one word for the whole batch
  // made queued suites read as running (UX-3).
  const batchCounts: Array<[string, number, string]> = (
    [
      ["in progress", siblings.filter((sib) => RUNNING_STATUSES.includes(sib.status)).length, "processing"],
      ["paused", siblings.filter((sib) => sib.status === "paused").length, "warning"],
      ["queued", siblings.filter((sib) => sib.status === "queued").length, "default"],
      ["completed", siblings.filter((sib) => sib.status === "finished").length, "success"],
      ["failed", siblings.filter((sib) => sib.status === "failed").length, "error"],
      ["canceled", siblings.filter((sib) => sib.status === "cancelled").length, "default"],
    ] as Array<[string, number, string]>
  ).filter(([, n]) => n > 0);
  // Header controls are gated on all suite statuses, not the selected tab's
  // stream, which may already have ended.
  const bulkTargets = inBatch ? siblings : run ? [run] : [];
  const canPauseAll = bulkTargets.some((r) => ACTIVE_STATUSES.includes(r.status));
  const canResumeAll = bulkTargets.some((r) => isResumableRun(r));
  const canCancelAll = bulkTargets.some((r) => ACTIVE_STATUSES.includes(r.status) || r.status === "paused");
  // Averages are shown once the run on screen has paused or completed; a
  // running suite shows its progress instead (decision of 2026-09-30).
  const runSettled = Boolean(run && !ACTIVE_STATUSES.includes(run.status));
  // The whole evaluation's progress, for the bar under the header: all the
  // suites of a batch while any of them is running, else the run on screen.
  const overall = inBatch
    ? { completed: batchTotals.completed, total: batchTotals.total }
    : { completed: run?.completed || 0, total: run?.total || 0 };
  const overallLive = inBatch
    ? siblings.some((sib) => RUNNING_STATUSES.includes(sib.status))
    : Boolean(isStreaming && run && run.status !== "queued");
  const neverStarted = Boolean(state.runState?.never_started);
  // The same status word every other surface shows for this run: it comes
  // from the run record and is updated by the stream's start/progress/done
  // events, never inferred from "the stream is open".
  const headerStatus = runStatusInfo(run?.status, {
      neverStarted,
      // Rows with a real error and no result; the header must not say
      // "Finished" over a table where every case failed.
      failedCases: state.aggregateMetrics.errorCount,
      total: state.aggregateMetrics.completedCases,
    },
  );

  // The feature of the evaluation: for several suites launched together,
  // the first suite launched names it on every tab (siblings are in launch
  // order), so the title does not change as the admin moves between tabs.
  const leadRun = inBatch ? siblings[0] : run;
  const feature = featureDefn || (leadRun ? featureDef(featureOfRun(leadRun)) : null);
  // "Evaluation Results: <what was evaluated>" — the feature for a feature
  // page or an evaluation of several suites, the suite for a single run.
  const pageTitle = `Evaluation Results: ${
    featureDefn
      ? featureDefn.title
      : inBatch && feature
      ? feature.title
      : suite || (run ? categoryOfRun(run).label : "Run")
  }`;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* The way back is the one navigation this page has (the evaluation
          history lives on the home page), so it is a real button. */}
      <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/")} style={{ marginBottom: 16 }}>
        Back to Evaluations
      </Button>
      <div style={{ minWidth: 0 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 16,
        }}
      >
        <div data-tour={TOUR_TARGETS.resultsHeader}>
          <h1 className="tds-h1">{pageTitle}</h1>
          {run && (
            <>
              <div style={{ marginTop: 8 }}>
                Evaluated model: <Text strong>{model || "unknown"}</Text>
                {cfg.model_provider && (
                  <Text type="secondary"> ({cfg.model_provider})</Text>
                )}
                {" · Status: "}
                {inBatch ? (
                  <Tooltip title={`Overall: ${batchStatus.label}`}>
                    <span>
                      {batchCounts.map(([label, n, color]) => (
                        <Tag key={label} color={color}>{`${n} ${label}`}</Tag>
                      ))}
                    </span>
                  </Tooltip>
                ) : (
                  <Tooltip title={(isPaused && state.runState?.pause_reason) || undefined}>
                    <Tag color={headerStatus.color}>{headerStatus.label}</Tag>
                  </Tooltip>
                )}
                {!inBatch && state.runState?.phase && ACTIVE_STATUSES.includes(run.status) && (
                  <Text type="secondary">{state.runState.phase}…</Text>
                )}
                {run.created_at && (
                  <>
                    {" · Start time: "}
                    <Text strong>{run.created_at}</Text>
                  </>
                )}
                {run.finished_at && (
                  <>
                    {" · End time: "}
                    <Text strong>{run.finished_at}</Text>
                  </>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 12 }}>
                <Text type="secondary">
                  {inBatch ? (
                    <>
                      {`${siblings.length} ${featureMode ? "capabilities with results" : "suites"} · ${batchTotals.finished} completed`}
                      {batchTotals.failed ? ` · ${batchTotals.failed} failed` : ""}
                      {batchTotals.cancelled ? ` · ${batchTotals.cancelled} canceled` : ""}
                      {activeSibling
                        ? ` · ${
                            activeSibling.status === "queued"
                              ? "Queued"
                              : activeSibling.status === "paused"
                              ? "Paused on"
                              : RUNNING_STATUSES.includes(activeSibling.status)
                              ? "Now"
                              : "Last"
                          }: ${activeSibling.suite_label || activeSibling.runner_name} (${
                            fmtCount(activeSibling.completed)
                          } of ${fmtCount(activeSibling.total)})`
                        : ""}
                      {judgeIdentity ? ` · Evaluator model: ${judgeIdentity}` : ""}
                      {` · ${fmtCount(batchTotals.completed)} of ${fmtCount(batchTotals.total)} total test cases`}
                    </>
                  ) : (
                    <>
                      {`Run ${run.job_id.slice(0, 8)} · `}
                      {devMode ? `Runner: ${run.runner_name || "unknown"} · ` : ""}
                      {devMode && cfg.gateway_url ? `Gateway: ${cfg.gateway_url} · ` : ""}
                      {judgeIdentity ? `Evaluator model: ${judgeIdentity} · ` : ""}
                      {`${fmtCount(run.completed)} of ${fmtCount(run.total)} test cases`}
                    </>
                  )}
                </Text>
              </div>
            </>
          )}
        </div>
        <span data-tour={TOUR_TARGETS.resultsActions}>
        <Space wrap>
          {/* Pause and Resume act on every suite of the evaluation: a pause
              stops the running suite and holds the queued ones, a resume
              re-queues every paused suite in launch order. */}
          {canPauseAll && (
            <Tooltip title={inBatch ? "Pause all suites, running and queued" : "Pause this run"}>
              <Button
                icon={<PauseOutlined />}
                aria-label={inBatch ? "Pause all suites" : "Pause this run"}
                loading={bulkBusy === "pause"}
                onClick={pauseAll}
              />
            </Tooltip>
          )}
          {canResumeAll && (
            <Tooltip title={inBatch ? "Resume all paused suites" : "Resume this run"}>
              <Button
                type="primary"
                icon={<CaretRightOutlined />}
                aria-label={inBatch ? "Resume all paused suites" : "Resume this run"}
                style={{ backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR }}
                loading={bulkBusy === "resume"}
                onClick={resumeAll}
              />
            </Tooltip>
          )}
          {canCancelAll && (
            // Tooltip outside, confirmation inside, like every other control
            // here: the confirmation attaches its click to its direct child,
            // and a Tooltip in between swallowed it (bug bash S6-1).
            <Tooltip title={inBatch ? "Cancel all suites, running, queued and paused" : "Cancel this run"}>
              <Popconfirm
                title={
                  inBatch
                    ? "Cancel all unfinished suites? Completed cases are kept."
                    : "Cancel this run? Completed cases are kept."
                }
                onConfirm={cancelAll}
              >
                <Button danger icon={<StopOutlined />} aria-label={inBatch ? "Cancel all suites" : "Cancel this run"} loading={cancelBusy} />
              </Popconfirm>
            </Tooltip>
          )}
          <Tooltip title="Download results">
            <Popover
              trigger="click"
              placement="bottomRight"
              content={
                <div className="tui-menu" role="menu">
                  <a className="tui-menu-item" role="menuitem" href={`${API_BASE}/nlq-eval/export/${jobId}?format=csv`} download>
                    Download CSV
                  </a>
                  <a className="tui-menu-item" role="menuitem" href={`${API_BASE}/nlq-eval/export/${jobId}?format=json`} download>
                    Download JSON
                  </a>
                </div>
              }
            >
              <Button icon={<DownloadOutlined />} disabled={state.rows.length === 0} aria-label="Download results" aria-haspopup="menu" />
            </Popover>
          </Tooltip>
          <Tooltip title="Publish to your Tableau Server">
            <Button
              type="primary"
              icon={<UploadOutlined />}
              aria-label="Publish to your Tableau Server"
              // The brand fill only when enabled: applied unconditionally it
              // overrode the disabled look and the button read as live.
              style={
                state.rows.length === 0 || isStreaming
                  ? undefined
                  : { backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR }
              }
              disabled={state.rows.length === 0 || isStreaming}
              onClick={() => setPublishOpen(true)}
            />
          </Tooltip>
        </Space>
        </span>
      </div>

      {neverStarted && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="This evaluation did not start"
          description={
            state.runState?.error ||
            "The tool was restarted while this evaluation was still waiting its turn. Evaluate it again from the home page."
          }
          action={
            <Button size="small" onClick={() => navigate("/")}>
              Back to Evaluations
            </Button>
          }
        />
      )}

      {/* A judge from the model's own family: the run went ahead, and its
          judge scores carry this warning for as long as they are shown. */}
      {cfg.judge_family_warning && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="The evaluator model shares a family with the evaluated model"
          description={cfg.judge_family_warning}
        />
      )}

      <EvaluationFeedback
        pending={bulkBusy === "resume" ? "Submitting resume request… Waiting for the server to confirm it."
          : bulkBusy === "pause" ? "Submitting pause request… Waiting for the server to confirm it."
          : cancelBusy ? "Submitting cancel request… Waiting for the server to confirm it." : undefined}
        status={inBatch ? activeSibling?.status : run?.status}
        phase={inBatch ? activeSibling?.phase : state.runState?.phase}
        reconnecting={reconnecting}
      />

      {/* Progress of the whole evaluation: every suite of a batch together
          (a single run is its own whole). The progress of the capability
          on screen is the bar in its Finished Test Cases card. */}
      {overallLive && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <LoadingOutlined style={{ marginTop: 3 }} />
            <Progress
              percent={overall.total ? Math.round((overall.completed / overall.total) * 100) : 0}
              style={{ flex: 1 }}
              status="active"
              label={
                (inBatch
                  ? `Evaluating ${fmtCount(overall.completed)} of ${fmtCount(overall.total)} test cases across ${siblings.length} ${featureMode ? "capabilities" : "suites"}`
                  : `Evaluating ${fmtCount(overall.completed)} of ${fmtCount(overall.total)} test cases`) + retryNote
              }
            />
          </div>
        </Card>
      )}

      {/* A stopped run says where it stopped, in the place the progress
          card occupied while it ran (bug bash S2-4). One line, not a
          full-width banner: that only pushed the results down the page. */}
      {!isStreaming && run && run.status === "cancelled" && (
        <Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
          Stopped at {fmtCount(run.completed)} of {fmtCount(run.total)} test cases — completed cases are kept.
        </Text>
      )}

      {/* Error banner */}
      {state.error && state.rows.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          message={state.error}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Result Summary | per-runner tabs (UX mock). Single-runner runs get
          one runner tab; both tabs share the tiles + score cards, the runner
          tab adds the case table. */}
      <Tabs
        activeKey={activeTab}
        onChange={(key: string) => {
          // A sibling tab is a different job: go there instead of switching
          // to an empty panel.
          if (key.startsWith("sib-")) navigate(resultsPath(key.slice(4)));
          else setActiveTab(key);
        }}
        items={orderTabs(([
          {
            key: "summary",
            label: "Result Summary",
            children: (
              <>
                {featureMode ? memberCards : siblings.length > 1 && (
                  <div style={{ marginBottom: 20 }}>
                    <div className="heading-with-legend">
                      <Text strong>Capabilities evaluated</Text>
                      <BaselineLegend />
                    </div>
                    <div className="capability-cards">
                      {siblings.map((sib) => {
                        const live = ACTIVE_STATUSES.includes(sib.status);
                        return (
                          <FlexCard
                            fill
                            key={sib.job_id}
                            title={suiteDisplayName(sib.suite_label, sib)}
                            extra={
                              <Tooltip title={`${fmtCount(sib.completed)} of ${fmtCount(sib.total)} test cases`}>
                                <Tag color={runStatusInfo(sib.status, { neverStarted: sib.never_started }).color} style={{ marginRight: 0 }}>
                                  {sib.status === "finished" && !(sib.failed_cases || 0)
                                    ? "Completed"
                                    : runStatusInfo(sib.status, { neverStarted: sib.never_started }).label}
                                </Tag>
                              </Tooltip>
                            }
                          >
                            {/* Running or queued: how far it is. Paused or
                                done: its numbers, as the lower cards show
                                them for the suite on screen. The status
                                itself is the tag in the card header. */}
                            {live ? (
                              <SuiteProgress completed={sib.completed || 0} total={sib.total || 0} queued={sib.status === "queued"} />
                            ) : !sib.never_started ? (
                              <SuiteSummaryTiles summary={suiteSummaries[sib.job_id]?.data} ended={sib.status === "finished"} base={baseOf(sib.ai_feature, sib.suite_id)} />
                            ) : null}
                            <div className="row-actions card-footer">
                              {sib.job_id !== jobId ? (
                                <RouterLink to={resultsPath(sib.job_id)} className="row-link" aria-label={`View Results for ${suiteDisplayName(sib.suite_label, sib)}`}>
                                  View Results
                                </RouterLink>
                              ) : (
                                <button type="button" className="row-link"
                                  onClick={() => setActiveTab("runner")}>
                                  View Results
                                </button>
                              )}
                              <span className="row-action-slot">
                                {["started", "running"].includes(sib.status) && (
                                  <Tooltip title="Pause">
                                    <button type="button" className="row-icon" aria-label="Pause this suite"
                                      onClick={() => jobAction("pause", "Pause requested", sib.job_id)}>
                                    <PauseOutlined />
                                  </button>
                                </Tooltip>
                                )}
                                {isResumableRun(sib) && (
                                  <Tooltip title="Resume">
                                    <button type="button" className="row-icon row-icon-primary" aria-label="Resume this suite"
                                      onClick={() => jobAction("resume", "Resumed", sib.job_id)}>
                                    <CaretRightOutlined />
                                  </button>
                                </Tooltip>
                                )}
                              </span>
                              <span className="row-action-slot">
                                {(["started", "running"].includes(sib.status) || isResumableRun(sib)) && (
                                  <Tooltip title="Cancel">
                                    <Popconfirm
                                      title={`Cancel ${suiteDisplayName(sib.suite_label, sib)}? Completed cases are kept.`}
                                      onConfirm={async () => { await jobAction("cancel", "Cancel requested", sib.job_id); }}
                                    >
                                      <button type="button" className="row-icon row-icon-danger" aria-label="Cancel this suite">
                                        <StopOutlined />
                                      </button>
                                    </Popconfirm>
                                  </Tooltip>
                                )}
                              </span>
                            </div>
                          </FlexCard>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ),
          },
          ...(featureMode
            ? members
                .filter((m) => !m.run || m.run.job_id !== jobId)
                .map((m) =>
                  m.run
                    ? { key: `sib-${m.run.job_id}`, label: tabLabel(m.cat.label, m.run, false, tabControlFor(m.run.job_id)), title: titleCase(m.cat.label), children: null }
                    : {
                        key: `cat-${m.cat.key}`,
                        label: tabLabel(m.cat.label, null, true),
                        title: titleCase(m.cat.label),
                        children: (
                          <Card size="small">
                            <div><Text strong>{m.cat.label}</Text></div>
                            <Text type="secondary">{m.cat.task.charAt(0).toUpperCase() + m.cat.task.slice(1)}</Text>
                            {(() => {
                              return (
                                <>
                                  <div style={{ marginTop: 8 }}>
                                    <Text type="secondary">
                                      {m.suite?.available
                                        ? `Not yet tested. The public suite has ${fmtCount(m.suite.case_count)} test cases.`
                                        : m.suite?.coming_soon
                                        ? "Coming soon — the public tests for this capability are being prepared."
                                        : "No tests for this capability on this machine."}
                                    </Text>
                                  </div>
                                  {m.suite?.available && (
                                    <Tooltip title={connReady === false ? launchBlocked : m.suite.server_supported === false ? m.suite.server_message : undefined}>
                                      <Button
                                        type="primary"
                                        size="small"
                                        icon={<CaretRightOutlined />}
                                        style={{ marginTop: 10, backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR }}
                                        loading={launchingCat === m.cat.key}
                                        disabled={connReady === false || m.suite.server_supported === false || (launchingCat !== null && launchingCat !== m.cat.key)}
                                        onClick={() => launchMember(m)}
                                      >
                                        Evaluate
                                      </Button>
                                    </Tooltip>
                                  )}
                                </>
                              );
                            })()}
                          </Card>
                        ),
                      },
                )
            : siblings
                .filter((sib) => sib.job_id !== jobId)
                .map((sib) => ({
                  key: `sib-${sib.job_id}`,
                  label: tabLabel(suiteDisplayName(sib.suite_label, sib), sib, false, tabControlFor(sib.job_id)),
                  title: titleCase(suiteDisplayName(sib.suite_label, sib)),
                  children: null,
                }))),
          {
            key: "runner",
            // The run on screen comes from the results payload, which carries no
            // failed_cases; take that count from the same history record the
            // other tabs use, so a tab keeps its colour when it is selected.
            label: tabLabel(
              runnerTabName,
              inBatch || featureMode
                ? run && { ...run, failed_cases: siblings.find((sib) => sib.job_id === run.job_id)?.failed_cases }
                : null,
              false,
              tabControlFor(run?.job_id),
            ),
            title: titleCase(runnerTabName),
            children: state.status === "loading" ? (
              <div style={{ padding: "48px 0", textAlign: "center" }} aria-busy="true">
                <LoadingOutlined style={{ fontSize: 24 }} />
                <div style={{ marginTop: 10 }}>
                  <Text type="secondary">Loading this suite's results…</Text>
                </div>
              </div>
            ) : (
              <>
                <div data-tour={TOUR_TARGETS.resultsTiles} style={{ marginBottom: 16 }}>
                  <StatTiles
                    metrics={state.aggregateMetrics}
                    total={run?.total || 0}
                    live={Boolean(run && RUNNING_STATUSES.includes(run.status))}
                    onShowErrors={() => setSortBy("errors")}
                  />
                </div>
                <div data-tour={TOUR_TARGETS.resultsScores} style={{ marginBottom: 20 }}>
                  {runSettled ? (
                    <QualityCards rows={state.rows} capability={capability} base={baseOf(capability, (runRecord ?? siblings.find((s) => s.job_id === jobId))?.suite_id)} />
                  ) : (
                    <Text type="secondary">Scores appear after the run is paused or is complete.</Text>
                  )}
                </div>

                <div data-tour={TOUR_TARGETS.resultsTable}>
                <Table<NlqEvalTableRow>
                  className="metrics-table"
                  columns={shownColumns}
                  onColumnMove={moveColumn}
                  dataSource={sortedRows}
                  rowKey="key"
                  size="small"
                  // The turns of a conversation are consecutive rows with a
                  // darker line before the first and after the last.
                  onRow={(row) => {
                    const turn = turnInfo.get(row.key);
                    const classes =
                      turn && turn.of > 1
                        ? `conv-turn${turn.turn === 1 ? " conv-first" : ""}${turn.turn === turn.of ? " conv-last" : ""}`
                        : undefined;
                    return { className: classes, ...(row.pending ? { style: { opacity: 0.55 } } : {}) };
                  }}
                  pagination={{
                    current: jobId ? pagesByRun[jobId] ?? 1 : 1,
                    onChange: (page) => {
                      if (jobId) setPagesByRun((prev) => ({ ...prev, [jobId]: page }));
                    },
                    pageSize: 50,
                    showSizeChanger: true,
                    pageSizeOptions: ["25", "50", "100", "200"],
                    // The count says when a search or filter is hiding cases.
                    showTotal: (total) =>
                      total === caseCount ? `${fmtCount(total)} test cases` : `${fmtCount(total)} of ${fmtCount(caseCount)} test cases`,
                    // One line above the table, on the page's three-column
                    // grid: search and datasource filter | sort | page
                    // controls. Expand/collapse and Show diff live in the
                    // headers of the columns they act on.
                    renderTop: (pager) => (
                      <>
                      <div className="summary-cards table-toolbar">
                        {/* Finding rows: search, and the datasource filter. */}
                        <div className="table-toolbar-group">
                          <Input
                            placeholder={isDashboardSuite ? "Search dashboards" : "Search requests"}
                            prefix={<SearchOutlined />}
                            value={searchText}
                            onChange={(e) => setSearchText(e.target.value)}
                            allowClear
                            style={{ flex: "1 1 0", minWidth: 0 }}
                          />
                          {datasources.length > 0 && (
                          <Select
                            // Reads as the filter's state: nothing chosen
                            // means every datasource is listed.
                            placeholder="All data sources"
                            aria-label="Filter by data source"
                            allowClear
                            value={datasourceFilter}
                            onChange={setDatasourceFilter}
                            style={{ flex: "0 1 170px", minWidth: 0 }}
                            options={datasources.map((d) => ({ label: d, value: d }))}
                          />
                          )}
                        </div>
                        {/* Ordering them. */}
                        <div className="table-toolbar-group">
                          <span className="table-toolbar-label">Sort by</span>
                          <Select
                            aria-label="Sort by"
                            value={sortBy}
                            onChange={setSortBy}
                            style={{ flex: "0 1 220px", minWidth: 0 }}
                            options={[
                              { value: "index", label: "Row number" },
                              ...(isDashboardSuite
                                ? [{ value: "name", label: "Dashboard name" }]
                                : []),
                              { value: "latency", label: "Slowest first" },
                              ...(domainPresence.viz
                                ? [{ value: "viz", label: "Lowest visualization score" }]
                                : []),
                              ...(domainPresence.calc
                                ? [{ value: "calc", label: `Lowest ${categoryLabel("calc", capability).toLowerCase()} score` }]
                                : []),
                              ...(domainPresence.nl
                                ? [{ value: "nl", label: "Lowest natural language score" }]
                                : []),
                              ...(domainPresence.palette
                                ? [{ value: "palette", label: "Lowest palette score" }]
                                : []),
                              ...(domainPresence.narrative
                                ? [{ value: "narrative", label: "Lowest narrative score" }]
                                : []),
                              ...(domainPresence.flowPlan
                                ? [{ value: "flowPlan", label: "Lowest flow plan score" }]
                                : []),
                              ...(domainPresence.intent
                                ? [{ value: "intent", label: "Lowest intent score" }]
                                : []),
                              ...(domainPresence.answer
                                ? [{ value: "answer", label: "Lowest answer score" }]
                                : []),
                              { value: "errors", label: "Errors first" },
                            ]}
                          />
                          <ColumnPicker
                            columns={arrangedColumns}
                            hidden={hiddenColumns}
                            changed={columnsChanged}
                            onToggle={toggleColumn}
                            onStep={stepColumn}
                            onReset={() => updateColumnSettings(NO_COLUMN_SETTINGS)}
                          />
                        </div>
                        {pager}
                      </div>
                      <div className="heading-with-legend" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
                        <BaselineLegend bands="fixed" baseline={tableBaseline} />
                      </div>
                      </>
                    ),
                  }}
                  // What the columns need together; the text and score
                  // columns grow from there to fill the window, and the
                  // table scrolls sideways only below that (bug bash S6-2).
                  scroll={{
                    x: shownColumns.reduce((sum, c) => sum + (Number(c.width) || 0), 0),
                  }}
                />
                </div>
              </>
            ),
          },
        ] as any[]).filter((it) => it.key !== "summary" || featureMode || siblings.length > 1))}
      />

      <DatasetPanel datasetId={openDataset} onClose={() => setOpenDataset(null)} />
      <DashboardPanel dashboard={openDashboard} onClose={() => setOpenDashboard(null)} />


      {/* Publish modal — publishes via the stored Tableau connection */}
      <Modal
        open={publishOpen}
        title="Publish Results to Tableau"
        onCancel={() => setPublishOpen(false)}
        onOk={doPublish}
        okText="Publish"
        confirmLoading={publishing}
        okButtonProps={{
          disabled: !tableauConn?.configured,
          style: { backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR },
        }}
      >
        {tableauConn === null ? (
          <Alert type="info" showIcon message="Checking Tableau connection…" />
        ) : tableauConn.configured ? (
          <Alert
            type="info"
            showIcon
            message={`Publishing to ${tableauConn.server_url}`}
            description={`Site: ${tableauConn.site || "(default)"}. Results go to the "${PUBLISH_DATASOURCE}" data source in the "${PUBLISH_PROJECT}" project; the first publish creates it, and later runs are added to it, tagged with their run id.`}
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message="No Tableau Server Connection"
            description="Connect to Tableau Server in Evaluation Setup, step 1, on the home page. Runs, connection tests, and publishing all reuse that connection."
          />
        )}
      </Modal>
      </div>
    </div>
  );
};

export default NlqResultsPage;
