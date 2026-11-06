/**
 * The NLQ-eval metric registry: categories, alias chains, weights,
 * quality cards and glosses, read from `metricCatalog.json` — a copy of
 * `packages/core/src/metrics/catalog.json`, refreshed by the frontend build
 * (`scripts/syncCatalog.ts`) and compared by a backend test. The backend
 * derives the exported and published scores from the same file with the
 * same rules, so the number on this page, on the home
 * page, in a CSV/JSON export and in the published datasource agree.
 *
 * Both implementations use the fixture in `goldens/metric_catalog/`:
 *  - a leaf resolves through alias names in order (precision falls back to
 *    SpecFieldAccuracy, calcValidity to equals, …);
 *  - averages are over non-null scores only;
 *  - a bucket with no populated leaves is dropped entirely;
 *  - a quality card's headline is the unweighted mean of its populated
 *    bucket averages;
 *  - judge-derived metrics are the ones under stage "llmJudge"
 *    — informationSimilarity is deterministic even though it rolls up under
 *    the NL card;
 *  - a judge leaf that EXISTS with a null score means the judge errored on
 *    that case → rendered "Unavailable", excluded from averages (WS2a).
 */

import catalog from "./metricCatalog.json";

/** Judge metrics live under this stage — the only judge/deterministic marker. */
export const JUDGE_STAGE: string = catalog.judge_stage;

/** Stage-grouped metrics, as streamed in SSE row payloads and rebuilt from
 *  the SQLite metrics table. */
export type StageMetrics = Record<
  string,
  Array<{
    metric_id?: string | null;
    metric_name: string;
    score: number | null;
    explanation?: string | null;
  }>
>;

export interface MetricLeafDef {
  stage: string;
  /** Alias chain — first name found (non-null score preferred) wins. */
  names: string[];
  label: string;
}

export interface BucketDef {
  key: string;
  label: string;
  /** Weight in the overall score; 0 = NL bucket, excluded from overall. */
  weight: number;
  /** The category's baseline for the run's capability, 0-1 (the catalog's
   *  `category_baselines_by_capability`, set by relabelBuckets): its pills
   *  are coloured against it (baseline.tsx `baselineTone`) instead of the
   *  33 / 66 bands. */
  baseline?: number;
  metrics: MetricLeafDef[];
}

/** The categories, in catalog order. */
export const METRIC_BUCKETS: BucketDef[] = catalog.categories;

/** A category's name as a run of a capability shows it: the catalog label,
 *  or the capability's own name for it ("Calculated Fields in Flows" for a
 *  Tableau Prep calculation run, whose category is the same Calculated
 *  Fields). */
const CATEGORY_LABELS_BY_CAPABILITY: Record<string, Record<string, string>> =
  (catalog as { category_labels_by_capability?: Record<string, Record<string, string>> })
    .category_labels_by_capability || {};

export function categoryLabel(key: string, capability?: string | null): string {
  const own = CATEGORY_LABELS_BY_CAPABILITY[capability || ""] || {};
  if (own[key]) return own[key];
  return METRIC_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

/** Per capability, the categories with their own baseline (the three Prep
 *  suites, agreed with the Tableau Prep team on 2026-10-22). */
const CATEGORY_BASELINES_BY_CAPABILITY: Record<string, Record<string, number>> =
  (catalog as { category_baselines_by_capability?: Record<string, Record<string, number>> })
    .category_baselines_by_capability || {};

/** Per capability, the baseline every score of its runs is read against
 *  (the catalog's `capability_baselines`; the baseline table of 2026-10-29). */
const CAPABILITY_BASELINES: Record<string, number> =
  (catalog as { capability_baselines?: Record<string, number> }).capability_baselines || {};

/** The baseline a capability's scores are coloured against, if it has one. */
export function capabilityBaseline(capability?: string | null): number | undefined {
  return CAPABILITY_BASELINES[capability || ""];
}

/** The baseline a category's pills are coloured against in a run of
 *  `capability`: the category's own if it has one, else the capability's;
 *  undefined keeps them on the 33 / 66 bands. */
export function categoryBaseline(key: string, capability?: string | null): number | undefined {
  return CATEGORY_BASELINES_BY_CAPABILITY[capability || ""]?.[key] ?? capabilityBaseline(capability);
}

/** The two Summary-tab quality cards. A card's `context_buckets` are
 *  categories shown inside it for reference (Intent and Spec inside
 *  Visualization Quality), left out of its average. */
export const QUALITY_CARDS: Array<{
  key: string;
  label: string;
  buckets: string[];
  context_buckets?: string[];
}> = catalog.quality_cards;

/** What each summary card measures and what a high score says about the
 *  model, keyed by quality-card or category key; shown on the card's title. */
export const CARD_EXPLAIN: Record<string, string> = catalog.card_explanations;

/**
 * A metric explanation in words. The formula checker reports an empty
 * formula as a parser error at the end of input followed by every token the
 * grammar could have accepted; new runs store the plain wording, and this
 * covers the runs recorded before.
 */
export function readableExplanation(text: unknown): string | null {
  if (!text) return null;
  // A live row can carry one finding per problem, as a list.
  if (Array.isArray(text)) {
    const parts = text.map(readableExplanation).filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  }
  if (typeof text !== "string") return String(text);
  if (/^(Syntax Error: )?Syntax error at line 1, column 0: mismatched input '<EOF>'|^Empty formula$/.test(text.trim())) {
    return "The model did not write a formula for this request, so there was nothing to check.";
  }
  return text.includes("Syntax error") ? text.replace(/\s+expecting\s+(\{[\s\S]*?\}|\S+)/, "") : text;
}

/** One-line glosses shown on hover. */
export const METRIC_EXPLAIN: Record<string, string> = catalog.metric_explanations;

/** Customer-facing capability names ("calc" → "Calculated fields"). */
export const CAPABILITY_LABELS: Record<string, string> = catalog.capabilities;

// ---------------------------------------------------------------------------
// Resolution + aggregation
// ---------------------------------------------------------------------------

export interface LeafValue {
  label: string;
  value: number | null;
  explanation: string | null;
  /** True when this leaf came from the llmJudge stage. */
  judge: boolean;
  /** True when the metric row exists at all (a judge row with a null score
   *  is present-but-Unavailable; an absent deterministic metric is not). */
  present: boolean;
  /** In an aggregate: how many test cases have a score for this metric.
   *  Some metrics apply to part of a suite only (a palette's Ground Truth
   *  Match needs expected colors, which few cases define). */
  count?: number;
}

export interface BucketValue {
  def: BucketDef;
  /** Populated leaves only (value non-null), plus judge "Unavailable" leaves. */
  items: LeafValue[];
  /** Mean over the non-null leaves; null when none. */
  avg: number | null;
}

/** The same buckets with each category named as the run's capability
 *  names it, and carrying the baseline the capability gives it; every
 *  card, column and breakdown row reads the label and the baseline from
 *  here. */
export function relabelBuckets(buckets: BucketValue[], capability?: string | null): BucketValue[] {
  if (!capability || !(CATEGORY_LABELS_BY_CAPABILITY[capability] || CATEGORY_BASELINES_BY_CAPABILITY[capability] || CAPABILITY_BASELINES[capability])) {
    return buckets;
  }
  return buckets.map((b) => ({
    ...b,
    def: { ...b.def, label: categoryLabel(b.def.key, capability), baseline: categoryBaseline(b.def.key, capability) },
  }));
}

/** Resolve one alias chain against a stage map. Prefers the first alias with
 *  a non-null score; falls back to the first alias that exists at all (so a
 *  judge failure is distinguishable from an absent metric). */
export function resolveLeaf(metrics: StageMetrics, leaf: MetricLeafDef): LeafValue | null {
  const list = metrics[leaf.stage];
  if (!list || !list.length) return null;
  let firstPresent: { score: number | null; explanation?: string | null } | null = null;
  for (const name of leaf.names) {
    const m = list.find((x) => x.metric_name === name);
    if (!m) continue;
    if (firstPresent === null) firstPresent = m;
    if (m.score !== null && m.score !== undefined) {
      return {
        label: leaf.label,
        value: m.score,
        explanation: readableExplanation(m.explanation),
        judge: leaf.stage === JUDGE_STAGE,
        present: true,
      };
    }
  }
  if (firstPresent === null) return null;
  return {
    label: leaf.label,
    value: null,
    explanation: readableExplanation(firstPresent.explanation),
    judge: leaf.stage === JUDGE_STAGE,
    present: true,
  };
}

const mean = (vals: number[]): number | null =>
  vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

/** Per-row buckets: populated leaves plus judge-Unavailable leaves; buckets
 *  with nothing at all are dropped (classic `_computeRowBuckets`). */
export function computeRowBuckets(metrics: StageMetrics): BucketValue[] {
  const out: BucketValue[] = [];
  for (const def of METRIC_BUCKETS) {
    const items = def.metrics
      .map((leaf) => resolveLeaf(metrics, leaf))
      .filter((x): x is LeafValue => x !== null);
    if (!items.length) continue;
    out.push({
      def,
      items,
      avg: mean(items.filter((i) => i.value !== null).map((i) => i.value as number)),
    });
  }
  return out;
}

/** Aggregate buckets across rows: per leaf, mean over rows where the leaf
 *  scored (classic `_avgRows` — null scores excluded, not zero-filled). */
export function computeAggregateBuckets(rowMetrics: StageMetrics[]): BucketValue[] {
  const out: BucketValue[] = [];
  for (const def of METRIC_BUCKETS) {
    const items: LeafValue[] = [];
    for (const leaf of def.metrics) {
      const resolved = rowMetrics
        .map((m) => resolveLeaf(m, leaf))
        .filter((x): x is LeafValue => x !== null);
      if (!resolved.length) continue;
      const scored = resolved.filter((r) => r.value !== null).map((r) => r.value as number);
      items.push({
        label: leaf.label,
        value: mean(scored),
        explanation: null,
        judge: leaf.stage === JUDGE_STAGE,
        present: true,
        count: scored.length,
      });
    }
    const populated = items.filter((i) => i.value !== null);
    if (!items.length) continue;
    out.push({ def, items, avg: mean(populated.map((i) => i.value as number)) });
  }
  return out;
}

/** Unweighted mean of populated bucket averages (classic `_bucketOverall`). */
export function bucketOverall(buckets: BucketValue[]): number | null {
  const avgs = buckets.filter((b) => b.avg !== null).map((b) => b.avg as number);
  return mean(avgs);
}

// ---------------------------------------------------------------------------
// Verdicts — three-state rows on config-driven thresholds.
// The bands come from the catalog (0.66 / 0.33) and stay "provisional"
// until the feature teams sign off on real thresholds (OQ-1).
// ---------------------------------------------------------------------------

export interface VerdictThresholds {
  /** Weighted overall at or above this = pass. */
  pass: number;
  /** At or above this (but below pass) = partial. */
  partial: number;
}

export const DEFAULT_THRESHOLDS: VerdictThresholds = {
  pass: catalog.verdict_thresholds.pass,
  partial: catalog.verdict_thresholds.partial,
};

export type Verdict = "pass" | "partial" | "fail" | "na";

/** Weighted overall across weight>0 buckets (NL buckets never gate a
 *  verdict — judge scoring is optional by design). */
export function weightedOverall(buckets: BucketValue[]): number | null {
  const weighted = buckets.filter((b) => b.def.weight > 0 && b.avg !== null);
  const totalWeight = weighted.reduce((a, b) => a + b.def.weight, 0);
  if (!totalWeight) return null;
  return weighted.reduce((a, b) => a + (b.avg as number) * (b.def.weight / totalWeight), 0);
}

export function rowVerdict(
  buckets: BucketValue[],
  thresholds: VerdictThresholds = DEFAULT_THRESHOLDS
): Verdict {
  const overall = weightedOverall(buckets);
  if (overall === null) return "na";
  if (overall >= thresholds.pass) return "pass";
  if (overall >= thresholds.partial) return "partial";
  return "fail";
}
