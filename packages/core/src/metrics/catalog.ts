/**
 * The metric catalog and derived scores, shared by exports and run summaries.
 *
 * `catalog.json` (next to this module) is the one description of every metric the
 * tool scores: its category, the category's weight in the overall score, its
 * display label and one-line meaning. The results page reads a copy
 * (`packages/frontend/src/metricCatalog.json`, refreshed by
 * `scripts/build-frontend.ts` and compared by `catalog.test.ts`), so the
 * number on the results page, the home page, a CSV/JSON export and the
 * published datasource is the same number.
 *
 * The scoring rules are a;
 * `catalog.test.ts` runs them over the shared parity fixture
 * (`goldens/metric_catalog/metric_parity.json`):
 *
 * - a metric resolves through an alias chain (`calcValidity` falls back to
 *   `equals`); the first alias with a score wins, else the first alias that
 *   exists at all, so a judge failure ("Unavailable", score null) is
 *   distinguishable from a metric that never ran;
 * - averages are over scored values only, never zero-filled;
 * - a category with nothing resolved is dropped;
 * - a quality card is the unweighted mean of its populated categories;
 * - the overall score is the weight-averaged mean of the populated categories
 *   whose weight is above zero (the natural-language categories weigh 0);
 * - a verdict thresholds the overall score (pass / partial / fail).
 */

import catalogJson from "./catalog.json" with { type: "json" };

export interface CatalogLeaf {
  stage: string;
  names: string[];
  label: string;
}

export interface CatalogCategory {
  key: string;
  label: string;
  weight: number;
  metrics: CatalogLeaf[];
}

export interface QualityCard {
  key: string;
  label: string;
  buckets: string[];
  /** Categories shown inside the card for reference, not in its average. */
  context_buckets?: string[];
}

export interface VerdictThresholds {
  pass: number;
  partial: number;
  provisional?: boolean;
}

export interface MetricCatalog {
  judge_stage: string;
  verdict_thresholds: VerdictThresholds;
  categories: CatalogCategory[];
  quality_cards: QualityCard[];
  metric_explanations: Record<string, string>;
  capabilities: Record<string, string>;
  category_labels_by_capability?: Record<string, Record<string, string>>;
  /** Per capability, the categories with their own baseline (the three Prep
   *  suites): the results page colours their pills against it. Each value
   *  equals the capability's `MEASURED_BASELINES` entry (a test checks). */
  category_baselines_by_capability?: Record<string, Record<string, number>>;
  /** Per capability, the baseline every score of its runs is coloured against. */
  capability_baselines?: Record<string, number>;
}

const CATALOG = catalogJson as unknown as MetricCatalog;

/** One metric as the results store shapes it. */
export interface CatalogMetric {
  metric_name: string;
  score: number | null | undefined;
  explanation?: string | null;
  metric_id?: string | null;
  [key: string]: unknown;
}

/** Metrics grouped by stage. */
export type StageMetrics = Record<string, CatalogMetric[]>;

export interface ResolvedLeaf {
  label: string;
  value: number | null;
  explanation: string | null;
  judge: boolean;
  present: true;
}

export interface Bucket {
  def: CatalogCategory;
  items: ResolvedLeaf[];
  avg: number | null;
}

export interface MetricDescription {
  label: string;
  category: string;
  category_key: string;
  category_weight: number;
  judge_derived: boolean;
  meaning: string;
}

export function loadCatalog(): MetricCatalog {
  return CATALOG;
}

let _fingerprint: string | null = null;
let _fingerprintOverride: string | null = null;

/**
 * A short hash of the catalog: first 12 hex digits of a sha256. Anything that stores a score computed from the
 * catalog (the home page keeps each finished run's scores) stores this beside
 * it and recomputes when it differs: a category, weight or metric added to
 * the catalog then reaches every surface at once.
 *
 * This hashes
 * `JSON.stringify` of the parsed catalog, because `bun build --compile` folds
 * a second `with { type: "text" }` import of the same file into the JSON
 * module, so the raw bytes are not available in the binary. The value
 * is stable for this implementation: it is only ever
 * compared with fingerprints this tool stored in its own database.
 */
export function fingerprint(): string {
  if (_fingerprintOverride !== null) return _fingerprintOverride;
  _fingerprint ??= new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(CATALOG))
    .digest("hex")
    .slice(0, 12);
  return _fingerprint;
}

/** Test seam: null restores the real hash. */
export function _setFingerprintForTest(value: string | null): void {
  _fingerprintOverride = value;
}

export function categories(): CatalogCategory[] {
  return CATALOG.categories;
}

export function qualityCards(): QualityCard[] {
  return CATALOG.quality_cards;
}

export function judgeStage(): string {
  return CATALOG.judge_stage;
}

export function thresholds(): VerdictThresholds {
  return CATALOG.verdict_thresholds;
}

/** Customer-facing capability name, or the raw key when unknown. */
export function capabilityLabel(capability: string | null | undefined): string {
  if (!capability) return "";
  return CATALOG.capabilities[capability] ?? capability;
}

/**
 * A category's name as a run of the given capability shows it: the catalog's
 * label, or the capability's own name for it ("Calculated fields in flows"
 * for a Tableau Prep calculation run, whose category is the same Calculated
 * Fields).
 */
export function categoryLabel(key: string, capability?: string | null): string {
  const own = CATALOG.category_labels_by_capability?.[capability ?? ""] ?? {};
  if (key in own) return own[key] as string;
  for (const c of categories()) {
    if (c.key === key) return c.label;
  }
  return key;
}

export function explanationFor(label: string): string {
  return CATALOG.metric_explanations[label] ?? "";
}

let _dictionary: Record<string, MetricDescription> | null = null;

/** Every catalogued metric keyed by `stage.metric_name` (every alias). */
export function metricDictionary(): Record<string, MetricDescription> {
  if (_dictionary) return _dictionary;
  const out: Record<string, MetricDescription> = {};
  for (const cat of categories()) {
    for (const leaf of cat.metrics) {
      for (const name of leaf.names) {
        const key = `${leaf.stage}.${name}`;
        if (key in out) continue;
        out[key] = {
          label: leaf.label,
          category: cat.label,
          category_key: cat.key,
          category_weight: cat.weight,
          judge_derived: leaf.stage === judgeStage(),
          meaning: explanationFor(leaf.label),
        };
      }
    }
  }
  _dictionary = out;
  return out;
}

/** Label/category/weight for one metric; unknown → "Other", weight 0. */
export function describeMetric(stage: string, name: string): MetricDescription {
  const known = metricDictionary()[`${stage}.${name}`];
  if (known) return known;
  return {
    label: name,
    category: "Other",
    category_key: "other",
    category_weight: 0,
    judge_derived: stage === judgeStage(),
    meaning: "",
  };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const isScored = (v: unknown): v is number => v !== null && v !== undefined;

/** Resolve one alias chain against a stage map. */
export function resolveLeaf(metrics: StageMetrics, leaf: CatalogLeaf): ResolvedLeaf | null {
  const rows = metrics[leaf.stage] ?? [];
  if (!rows.length) return null;
  const judge = leaf.stage === judgeStage();
  let firstPresent: CatalogMetric | null = null;
  for (const name of leaf.names) {
    const m = rows.find((x) => x.metric_name === name);
    if (!m) continue;
    if (firstPresent === null) firstPresent = m;
    if (isScored(m.score)) {
      return {
        label: leaf.label,
        value: Number(m.score),
        explanation: m.explanation || null,
        judge,
        present: true,
      };
    }
  }
  if (firstPresent === null) return null;
  return {
    label: leaf.label,
    value: null,
    explanation: firstPresent.explanation || null,
    judge,
    present: true,
  };
}

/** One case's categories. */
export function computeRowBuckets(metrics: StageMetrics): Bucket[] {
  const out: Bucket[] = [];
  for (const cat of categories()) {
    const items = cat.metrics
      .map((leaf) => resolveLeaf(metrics, leaf))
      .filter((r): r is ResolvedLeaf => r !== null);
    if (!items.length) continue;
    out.push({ def: cat, items, avg: mean(items.map((i) => i.value).filter(isScored)) });
  }
  return out;
}

/** Categories across cases: per-leaf mean over cases where it scored. */
export function computeAggregateBuckets(rowMetrics: Iterable<StageMetrics>): Bucket[] {
  const rows = [...rowMetrics];
  const out: Bucket[] = [];
  for (const cat of categories()) {
    const items: ResolvedLeaf[] = [];
    for (const leaf of cat.metrics) {
      const resolved = rows
        .map((m) => resolveLeaf(m, leaf))
        .filter((r): r is ResolvedLeaf => r !== null);
      if (!resolved.length) continue;
      items.push({
        label: leaf.label,
        value: mean(resolved.map((r) => r.value).filter(isScored)),
        explanation: null,
        judge: leaf.stage === judgeStage(),
        present: true,
      });
    }
    if (!items.length) continue;
    out.push({ def: cat, items, avg: mean(items.map((i) => i.value).filter(isScored)) });
  }
  return out;
}

/** Unweighted mean of populated category averages (a quality card). */
export function bucketOverall(buckets: Bucket[]): number | null {
  return mean(buckets.map((b) => b.avg).filter(isScored));
}

/** The overall score: weight-averaged over populated weighted categories. */
export function weightedOverall(buckets: Bucket[]): number | null {
  const weighted = buckets.filter((b) => b.def.weight > 0 && isScored(b.avg));
  const total = weighted.reduce((a, b) => a + b.def.weight, 0);
  if (!total) return null;
  // Same accumulation order as Python's sum(avg * (w / total)).
  let s = 0;
  for (const b of weighted) s += (b.avg as number) * (b.def.weight / total);
  return s;
}

export type Verdict = "pass" | "partial" | "fail" | "na";

export function verdict(overall: number | null | undefined): Verdict {
  if (!isScored(overall)) return "na";
  const t = thresholds();
  if (overall >= t.pass) return "pass";
  if (overall >= t.partial) return "partial";
  return "fail";
}

/** Each quality card's score over the given categories. */
export function cardScores(buckets: Bucket[]): Record<string, number | null> {
  const byKey = new Map(buckets.map((b) => [b.def.key, b]));
  const out: Record<string, number | null> = {};
  for (const card of qualityCards()) {
    const populated = card.buckets
      .map((k) => byKey.get(k))
      .filter((b): b is Bucket => b !== undefined);
    out[card.key] = populated.length ? bucketOverall(populated) : null;
  }
  return out;
}

export interface HeadlineScore {
  key: string;
  label: string;
  average: number;
  /** How many scored metrics the average is over. */
  total_scores: number;
  /** How many of those the LLM judge scored. */
  judge_scores: number;
  /**
   * A card's context categories (Intent and Spec beside Visualization
   * Quality), listed for reference: not in its average and not a headline of
   * their own.
   */
  context?: HeadlineScore[];
}

/**
 * The averages a run is summarised by on the home page and in the suite
 * cards: `[{key, label, average}]`, no single blended number.
 *
 * A capability has as many headline scores as it has measures: each
 * populated quality card whose categories carry weight (Visualization
 * Quality), then each populated weighted category no card covers, heaviest
 * first (Calculated Fields, Palette Quality, Narrative Quality, then Intent &
 * Spec), then the cards made only of unweighted categories (Natural Language
 * Quality, the judge's view). The exports carry no blended run score either;
 * `weightedOverall` is the per-case score (`case_score`) only. A category is
 * named as the run's capability names it (`categoryLabel`).
 */
export function headlineScores(buckets: Bucket[], capability?: string | null): HeadlineScore[] {
  const weights = new Map(categories().map((c) => [c.key, c.weight]));
  const cards = cardScores(buckets);
  let covered = new Set(qualityCards().flatMap((card) => card.buckets));
  const byKey = new Map(buckets.map((b) => [b.def.key, b]));
  // How many scored metrics are behind the average, and how many of them the
  // judge scored: a run with the judge on and one with it off average
  // different metrics, and the surfaces say so.
  const counts = (bs: Bucket[]) => {
    const items = bs.flatMap((b) => b.items).filter((i) => isScored(i.value));
    return { total_scores: items.length, judge_scores: items.filter((i) => i.judge).length };
  };
  const leading: HeadlineScore[] = [];
  const trailing: HeadlineScore[] = [];
  for (const card of qualityCards()) {
    const avg = cards[card.key];
    if (!isScored(avg)) continue;
    const entry = {
      key: card.key,
      label: card.label,
      average: avg,
      ...counts(card.buckets.map((k) => byKey.get(k)).filter((b): b is Bucket => b !== undefined)),
    } as HeadlineScore;
    // A card's context categories ride along for reference: listed with the
    // card, not in its average, and not as a headline of their own.
    const context: HeadlineScore[] = [];
    for (const k of card.context_buckets ?? []) {
      const b = byKey.get(k);
      if (!b || !isScored(b.avg)) continue;
      context.push({ key: k, label: categoryLabel(k, capability), average: b.avg, ...counts([b]) });
    }
    if (context.length) {
      entry.context = context;
      covered = new Set([...covered, ...context.map((c) => c.key)]);
    }
    (card.buckets.some((k) => (weights.get(k) ?? 0) > 0) ? leading : trailing).push(entry);
  }
  // Array.prototype.sort is stable, like Python's sorted().
  const standalone = buckets
    .filter((b) => !covered.has(b.def.key) && b.def.weight > 0 && isScored(b.avg))
    .sort((a, b) => b.def.weight - a.def.weight);
  return [
    ...leading,
    ...standalone.map((b) => ({
      key: b.def.key,
      label: categoryLabel(b.def.key, capability),
      average: b.avg as number,
      ...counts([b]),
    })),
    ...trailing,
  ];
}

/** Group the results store's metric rows ({stage, …}) into a stage map. */
export function stageMap(
  metricRows: Iterable<{ stage: string } & CatalogMetric>,
): StageMetrics {
  const out: StageMetrics = {};
  for (const m of metricRows) {
    const list = out[m.stage] ?? [];
    list.push(m);
    out[m.stage] = list;
  }
  return out;
}
