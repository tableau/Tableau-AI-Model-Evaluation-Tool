/**
 * Metrics-config resolution for the native harness runner.
 *
 * Which metrics each runner computes: the metric configurations are embedded
 * here as data, keyed by
 * `metrics_file` name, and expose them as {@link MetricConfigEntry} lists per
 * stage. The runner dispatches each entry's `metric` name through the ported
 * `computeMetric` registry (src/metrics/classes.ts).
 *
 * Only the deterministic metrics the customer path selects are embedded:
 *   - `byollm_metrics`      — calc suites (intent + calculatedFieldFormula).
 *   - `byollm_viz_metrics`  — viz-authoring suites (intent + notionalSpec).
 *   - `byollm_palette_metrics` — colour-palette suites (the four deterministic
 *                             palette checks; the valid/relevance/design rubric
 *                             is scored by the BYOK judge, not here).
 *   - `metrics-plan`        — multistep suites (intent + steps; judge-only for
 *                             steps, so only Equals on intent is deterministic).
 *
 * The `LLMEvaluation`/`NotionalSpecJudge`/etc. judge entries are intentionally
 * omitted from the deterministic path — the orchestrator attaches LLM-judge
 * metrics separately (src/judge/judge.ts).
 */

export interface MetricConfigEntry {
  /** Metric class name (dispatched via computeMetric). */
  metric: string;
  /** Optional per-metric `name` override (e.g. chartEquals). */
  name?: string;
  /** Optional key override (rare; mirrors MetricConfiguration key). */
  key?: string;
}

/** stage -> ordered metric entries. */
export type StageMetrics = Record<string, MetricConfigEntry[]>;

// ---------------------------------------------------------------------------
// Embedded metric configurations.
// ---------------------------------------------------------------------------

const BYOLLM_METRICS: StageMetrics = {
  intent: [{ metric: "Equals" }],
  calculatedFieldFormula: [
    { metric: "CalcValidity" },
    { metric: "CalcFieldValidity" },
    { metric: "CalcFieldAccuracy" },
    { metric: "CalcValueAccuracy" },
  ],
};

// Whole-definition Equals is not used on notionalSpec:
// the server's chart definitions carry another version number than the test
// cases, so it was 0 on every case.
const BYOLLM_VIZ_METRICS: StageMetrics = {
  intent: [{ metric: "Equals" }],
  notionalSpec: [
    { metric: "SpecFieldValidity" },
    { metric: "SpecFieldAccuracy" },
  ],
};

const METRICS_PLAN: StageMetrics = {
  intent: [{ metric: "Equals" }],
  // `steps` is judge-only (LLMEvaluation) in metrics-plan.json — no
  // deterministic metric. The orchestrator handles the judge separately.
  steps: [],
};

/**
 * The color-palette metrics config. The DETERMINISTIC palette checks only:
 *   - ColorPaletteDistinguishability (regular palettes),
 *   - GradientSmoothness (sequential/diverging),
 *   - DivergingPaletteStructure (diverging),
 *   - GroundTruthColorPaletteEvaluation.
 * The three LLM-scored dimensions (valid/relevance/design) are DELIBERATELY
 * absent to avoid the site's model judging its own palettes.
 * The tool scores that rubric with the Settings-configured
 * BYOK judge instead (packages/core/src/judge/palette_judge.ts, attached by the
 * orchestrator into the llmJudge stage). Thresholds are left at the metric
 * defaults, which equal the JSON's values (10/30/10).
 */
const BYOLLM_PALETTE_METRICS: StageMetrics = {
  colorPalette: [
    { metric: "ColorPaletteDistinguishability" },
    { metric: "GradientSmoothness" },
    { metric: "DivergingPaletteStructure" },
    { metric: "GroundTruthColorPaletteEvaluation" },
  ],
};

/**
 * The full `metrics.json` config. Unlike the trimmed `byollm_*` configs it
 * includes the ect-server "context" metrics that read
 * `_context.opensearch_query.matched`:
 *   - calculatedFieldFormula: SemanticSearchAccuracy + FieldRankScorer
 *     (key="formula"),
 *   - notionalSpec:           SpecSemanticSearchAccuracy.
 * The `chart` sub-key Equals on notionalSpec is renamed chartEquals in
 * metrics.json and needs a `key="chart"` unwrap the deterministic harness does
 * not yet perform; to avoid emitting an incorrect chartEquals we keep the
 * plain notionalSpec Equals form (byollm_viz_metrics used it until
 * the scoring contract) and only ADD SpecSemanticSearchAccuracy. Judge
 * entries (LLMEvaluation/NotionalSpecJudge/CompatibilityCheck) are attached by
 * the orchestrator, so they are omitted from the deterministic list.
 */
const METRICS_FULL: StageMetrics = {
  intent: [{ metric: "Equals" }],
  calculatedFieldFormula: [
    { metric: "CalcValidity" },
    { metric: "CalcFieldValidity" },
    { metric: "CalcFieldAccuracy" },
    { metric: "CalcValueAccuracy" },
    { metric: "SemanticSearchAccuracy" },
    { metric: "FieldRankScorer" },
  ],
  notionalSpec: [
    { metric: "Equals" },
    { metric: "SpecFieldValidity" },
    { metric: "SpecFieldAccuracy" },
    { metric: "SpecSemanticSearchAccuracy" },
  ],
  steps: [],
};

const REGISTRY: Record<string, StageMetrics> = {
  byollm_metrics: BYOLLM_METRICS,
  byollm_viz_metrics: BYOLLM_VIZ_METRICS,
  byollm_palette_metrics: BYOLLM_PALETTE_METRICS,
  "metrics-plan": METRICS_PLAN,
  "metrics-calcs": BYOLLM_METRICS,
  metrics: METRICS_FULL,
};

// Runner name → default metrics config, for when `metrics_file` is absent.
const RUNNER_DEFAULTS: Record<string, StageMetrics> = {
  "ect-server": BYOLLM_VIZ_METRICS, // viz-authoring is the common ect-server suite
  "multistep-plan": METRICS_PLAN,
  "calc-prompt": BYOLLM_METRICS,
  "color-palettes-server": BYOLLM_PALETTE_METRICS,
  // Narrative metrics require the configured judge/artifact context; don't
  // mistake this valid stage for an authoring stage with missing metrics.
  "dashboard-viz-narrative-config": { insightNarrative: [{ metric: "LLMEvaluation" }] },
};

/**
 * Resolve the per-stage metric config for a run.
 *
 * `metricsFile` is the `config.metrics_file` value (e.g. "byollm_metrics",
 * possibly with a path/extension). Falls back to a runner-based default so a
 * run without an explicit metrics_file still scores something sensible.
 */
export function getMetricsConfig(metricsFile: string, runner: string): StageMetrics {
  const name = normalizeName(metricsFile);
  if (name && REGISTRY[name]) return REGISTRY[name];
  if (RUNNER_DEFAULTS[runner]) return RUNNER_DEFAULTS[runner];
  // Safe universal default: intent + the union of calc & viz stages so any
  // expected key finds at least the deterministic metrics it supports.
  return {
    intent: [{ metric: "Equals" }],
    calculatedFieldFormula: BYOLLM_METRICS.calculatedFieldFormula!,
    notionalSpec: BYOLLM_VIZ_METRICS.notionalSpec!,
    steps: [],
  };
}

/** Strip any directory + `.json` extension from a metrics_file value. */
function normalizeName(metricsFile: string): string {
  if (!metricsFile) return "";
  const base = metricsFile.split(/[\\/]/).pop() ?? metricsFile;
  return base.replace(/\.json$/i, "").trim();
}
