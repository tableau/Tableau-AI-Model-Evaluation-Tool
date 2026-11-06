/**
 * Metric-class registry / dispatch for the scoring engine.
 *
 * Metric dispatch by name: an explicit TS registry
 * mapping metricName -> computeFn.
 *
 * Each computeFn takes the inputs a metric's compute step takes
 * (test_case / expected / actual / data) in a TS-shaped form and returns
 * ComputedMetric-shaped results ({metric_id, metric_name, score, explanation?}).
 *
 * The heavy lifting is delegated to the ALREADY-PORTED lib primitives:
 *   - lib/tfidf.ts    (ConcisenessScorer)
 *   - lib/ir.ts       (RanxMetrics family: precision/recall/hit_rate@k/map/mrr)
 *   - lib/ciede2000.ts (color palette metrics)
 *   - lib/fuzzy.ts    (numerical-factuality subject relevance)
 *   - lib/flesch.ts   (ReadabilityScorer)
 *   - viz.ts          (the tool's viz-quality metrics, separate entrypoint)
 *   - validator/      (CalcValidity)
 *   - judge/judge.ts  (LLM-judge metrics)
 *
 * ----------------------------------------------------------------------------
 * SUBSTITUTES / KNOWN DIVERGENCES
 * ----------------------------------------------------------------------------
 *  1. ReadabilityScorer: the reference implementation uses nltk punkt for sentence segmentation.
 *     We substitute lib/flesch.ts's regex sentence tokenizer (documented
 *     divergence). Tolerance-relaxed on prose with abbreviations/decimals.
 *  2. DashboardNarrativeNumerical* (Recall/Precision): the reference implementation uses spaCy
 *     `en_core_web_trf` NER only to answer "is this number inside a DATE/TIME
 *     span?" (is_date_related). We provide an INJECTABLE `dateEntityDetector`
 *     seam defaulting to a lightweight rules/regex detector — NO heavy model
 *     pulled here. Label-set / span divergence vs spaCy is expected and
 *     pre-flagged; these metrics are tolerance-relaxed.
 */

import { offDiagonalSimilaritySum } from "./lib/tfidf.ts";
import {
  evaluate as irEvaluate,
  evaluateMulti as irEvaluateMulti,
  EmptyRunError,
} from "./lib/ir.ts";
import type { QrelsForQuery, RunForQuery, MultiQrels, MultiRun } from "./lib/ir.ts";
import { hexToLab, deltaECIE2000, distinguishabilityScore } from "./lib/ciede2000.ts";
import { tokenSetRatio, partialRatio } from "./lib/fuzzy.ts";
import { readingEase } from "./lib/flesch.ts";
import { TableauValidator } from "../validator/tableau_validator.ts";
import {
  detectDateTimeSpans as defaultDateDetector,
  type DateEntityDetector,
} from "./date_entities.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ComputedMetric {
  metric_id: string;
  metric_name: string;
  score: number;
  explanation?: string | null;
}

/**
 * The test case / expected / actual / data a metric receives. Only the fields each metric actually reads are
 * modeled; everything is optional so callers can pass minimal inputs.
 */
export interface MetricContext {
  /** The natural-language utterance (ranx uses it as the single query key). */
  utterance?: string;
  /** Ground-truth value (already unwrapped by `key`, mirroring MetricConfiguration.__get_value). */
  expected?: unknown;
  /** Actual/model value (already unwrapped by `key`). */
  actual?: unknown;
  /** Extra data dict (semanticsearch_results, pulse insights, etc.). */
  data?: Record<string, unknown>;
  /** Datasource fields [{caption, datatype}] for validity metrics. */
  datasourceFields?: { caption: string; datatype?: string }[];
  /** Parsed calc fields/values (Phase-5 parser output) if the caller has them. */
  parsedExpectedFields?: string[];
  parsedActualFields?: string[];
  parsedExpectedValues?: string[];
  parsedActualValues?: string[];
  /** The literal as written, per normalised value (CalcValueAccuracy explanations). */
  expectedValueText?: Record<string, string>;
  actualValueText?: Record<string, string>;
  /**
   * CES `_context.opensearch_query.matched` list, captured as
   * `data["semanticsearch_results"]`. Consumed by the semantic
   * search / field-rank context metrics. Each entry is either a flat matched
   * field ({fieldName}) or a chunk with a `matches` list
   * ({chunk, matches:[{fieldName, score, filtered}]}).
   */
  semanticsearchResults?: unknown[] | null;
  /** Color-palette context (evaluator_data equivalent). */
  paletteType?: string;
  colors?: string[];
  /** Injectable NER date detector for numerical-factuality metrics. */
  dateEntityDetector?: DateEntityDetector;
  /** Metric-specific config kwargs (thresholds, keywords, etc.). */
  config?: Record<string, unknown>;
}

export type ComputeFn = (ctx: MetricContext) => ComputedMetric[];

// A stable metric_id per metric name (the reference implementation uses an md5 of the config; for the
// offline assembly layer a stable name-derived id is sufficient and parity-safe
// because the DB looks metrics up by stage + metric_name).
function metricId(name: string): string {
  return `Metric:${name}`;
}

function entry(name: string, score: number, explanation: string | null = null): ComputedMetric {
  const s = Math.max(0.0, Math.min(1.0, Number(score)));
  return { metric_id: metricId(name), metric_name: name, score: s, explanation };
}

// ---------------------------------------------------------------------------
// Collect values at any of `keys` in a tree.
// ---------------------------------------------------------------------------

export function findSubEntries(obj: unknown, keys: string[]): unknown[] {
  const acc: unknown[] = [];
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) acc.push((obj as Record<string, unknown>)[key]);
    }
    for (const k of Object.keys(obj)) {
      acc.push(...findSubEntries((obj as Record<string, unknown>)[k], keys));
    }
  } else if (Array.isArray(obj)) {
    for (const v of obj) acc.push(...findSubEntries(v, keys));
  }
  return acc;
}

/** Build ranx qrels/run dicts from a list of (caption, grade) tuples. */
function toQrelsRun(pairs: [string, number][]): QrelsForQuery {
  const out: QrelsForQuery = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Equals
// ---------------------------------------------------------------------------

/** float(expected == actual). Uses deep JSON equality for objects/arrays. */
export function computeEquals(ctx: MetricContext): ComputedMetric[] {
  const name = (ctx.config?.name as string) || "equals";
  const eq = deepEqual(ctx.expected, ctx.actual);
  return [entry(name, eq ? 1.0 : 0.0)];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  // Cheap structural fast-rejects that CANNOT change the canonical-JSON result:
  // array-vs-object type mismatch, and array length mismatch (JSON.stringify
  // never drops array elements). NOTE: we deliberately do NOT fast-reject on
  // object key-count — a key whose value is `undefined` is dropped by
  // JSON.stringify, so `{x:undefined}` and `{}` are canonical-equal despite
  // different key counts. Anything passing these falls through to the exact
  // canonical-JSON comparison, so semantics are unchanged.
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr && a.length !== b.length) return false;
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// RanxMetrics family
// ---------------------------------------------------------------------------

/**
 * Core RanxMetrics._compute: given expected/actual as (caption, grade) lists
 * and a metric list, emit one ComputedMetric per metric. Mirrors the
 * short-circuits:
 *   - expected empty  -> [] (metrics don't make sense)
 *   - actual empty    -> 0.0 per metric
 */
export function computeRanx(
  expectedPairs: [string, number][],
  actualPairs: [string, number][],
  metrics: string[],
  utterance: string,
  nameOverrides?: (metric: string) => string,
): ComputedMetric[] {
  if (expectedPairs.length === 0) return [];
  const rename = (m: string) => (nameOverrides ? nameOverrides(m) : m);
  if (actualPairs.length === 0) {
    return metrics.map((m) => entry(rename(m), 0.0));
  }
  const qrels: QrelsForQuery = toQrelsRun(expectedPairs);
  const run: RunForQuery = toQrelsRun(actualPairs);
  void utterance; // single-query; utterance is only the dict key
  const result = irEvaluate(qrels, run, metrics);
  return metrics.map((m) => entry(rename(m), result[m]));
}

function captionPairs(obj: unknown): [string, number][] {
  const caps = new Set<string>(findSubEntries(obj, ["field", "caption"]).filter((c) => typeof c === "string"));
  return [...caps].map((c) => [c, 1] as [string, number]);
}

/** SpecFieldAccuracy (L647): precision + recall over spec field captions. */
export function computeSpecFieldAccuracy(ctx: MetricContext): ComputedMetric[] {
  const expectedFields = captionPairs(ctx.expected);
  const actualFields = captionPairs(ctx.actual);
  return computeRanx(expectedFields, actualFields, ["precision", "recall"], ctx.utterance || "");
}

/** SpecFieldValidity (L669): precision of actual fields vs datasource fields, renamed fieldValidity. */
export function computeSpecFieldValidity(ctx: MetricContext): ComputedMetric[] {
  const datasourceFields: [string, number][] = (ctx.datasourceFields || []).map((f) => [f.caption, 1]);
  const actualFields = captionPairs(ctx.actual);
  const res = computeRanx(datasourceFields, actualFields, ["precision"], ctx.utterance || "");
  if (res[0]) res[0].metric_name = "fieldValidity";
  return res;
}

/** CalcFieldAccuracy (L765): precision/recall over parsed calc fields -> fieldPrecision/fieldRecall. */
export function computeCalcFieldAccuracy(ctx: MetricContext): ComputedMetric[] {
  const expectedFields: [string, number][] = (ctx.parsedExpectedFields || []).map((c) => [c, 1]);
  const actualFields: [string, number][] = (ctx.parsedActualFields || []).map((c) => [c, 1]);
  return computeRanx(expectedFields, actualFields, ["precision", "recall"], ctx.utterance || "", (m) =>
    m.replace("precision", "fieldPrecision").replace("recall", "fieldRecall"),
  );
}

/** CalcFieldValidity (L738): precision of parsed actual calc fields vs datasource -> calcFieldValidity. */
export function computeCalcFieldValidity(ctx: MetricContext): ComputedMetric[] {
  const datasourceFields: [string, number][] = (ctx.datasourceFields || []).map((f) => [f.caption, 1]);
  const actualFields: [string, number][] = (ctx.parsedActualFields || []).map((c) => [c, 1]);
  const res = computeRanx(datasourceFields, actualFields, ["precision"], ctx.utterance || "");
  if (res[0]) res[0].metric_name = "calcFieldValidity";
  return res;
}

/**
 * CalcValueAccuracy (L799): valuePrecision / valueRecall over the literal
 * values (numbers and text, not date parts) the generated formula shares with
 * the expected one. Text compares ignoring case, and the explanation says when
 * only the case differs, since Tableau itself is case-sensitive. No values on
 * either side -> no metrics; an expected formula without values makes extra
 * values in the answer count against precision, and recall is left out.
 * `parsedExpectedValues` undefined = no ground truth -> no metrics.
 */
export function computeCalcValueAccuracy(ctx: MetricContext): ComputedMetric[] {
  if (ctx.parsedExpectedValues === undefined) return [];
  const expectedValues = new Set(ctx.parsedExpectedValues);
  const actualValues = new Set(ctx.parsedActualValues || []);
  if (expectedValues.size === 0 && actualValues.size === 0) return [];
  const expectedText = ctx.expectedValueText || {};
  const actualText = ctx.actualValueText || {};
  const textOf = (texts: Record<string, string>, k: string) => texts[k] ?? k.slice(2);

  const sortedKeys = (keys: Iterable<string>) => [...keys].sort(pyStrCompare);
  const matched = [...expectedValues].filter((k) => actualValues.has(k));
  const missing = [...expectedValues].filter((k) => !actualValues.has(k));
  const extra = [...actualValues].filter((k) => !expectedValues.has(k));
  const shown = (keys: string[], texts: Record<string, string>) =>
    sortedKeys(keys)
      .map((k) => textOf(texts, k))
      .join(", ");
  const caseNotes = sortedKeys(matched)
    .filter((k) => {
      if (!k.startsWith("s:")) return false;
      const a = textOf(actualText, k);
      const e = textOf(expectedText, k);
      return a.toLowerCase() === e.toLowerCase() && a !== e;
    })
    .map(
      (k) =>
        `${textOf(actualText, k)} counts as ${textOf(expectedText, k)} (only the case differs; Tableau itself is case-sensitive)`,
    );
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${shown(missing, expectedText)}`);
  if (extra.length > 0) parts.push(`extra: ${shown(extra, actualText)}`);
  const detail = parts.length > 0 ? ` (${parts.join("; ")})` : "";
  const notes = caseNotes.length > 0 ? ` ${caseNotes.join(". ")}.` : "";

  if (expectedValues.size === 0) {
    const explanation = `The expected formula has no literal values; the answer adds ${shown(extra, actualText)}.`;
    return [entry("valuePrecision", 0.0, explanation)];
  }
  const explanation = `Matched ${matched.length} of ${expectedValues.size} expected values${detail}.${notes}`;
  const precision = actualValues.size > 0 ? matched.length / actualValues.size : 0.0;
  const recall = matched.length / expectedValues.size;
  return [entry("valuePrecision", precision, explanation), entry("valueRecall", recall, explanation)];
}

/** Python `sorted()` order for str: by code point. */
function pyStrCompare(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const d = ca[i]!.codePointAt(0)! - cb[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ca.length - cb.length;
}

// ---------------------------------------------------------------------------
// Context metrics: SemanticSearchAccuracy,
// SpecSemanticSearchAccuracy, FieldRankScorer.
//
// These read `data["semanticsearch_results"]`, which the runner populates from
//   response.intentApplicationDetection.result._context.opensearch_query.matched
// Servers may omit that context; fixtures pin the scoring behavior when present.
//
// The `matched` list is a mix of two shapes:
//   - flat matched field:  {fieldName: "...", ...}
//   - chunk with matches:  {chunk: "...", matches: [{fieldName, score, filtered}]}
// Only matches with `filtered === false` count (strict `is False` in Python).
// ---------------------------------------------------------------------------

/**
 * Collect the opensearch matched field names, faithful to Python's loop in
 * SemanticSearchAccuracy/SpecSemanticSearchAccuracy._compute (L836-844):
 *
 *   for search_result in semanticsearch_results:
 *       if "matches" in search_result:
 *           for match in search_result["matches"]:
 *               if match["filtered"] is False:
 *                   opensearch_matched_fields.add(match["fieldName"])
 *       else:
 *           opensearch_matched_fields.add(search_result["fieldName"])
 *
 * Note Python's `match["filtered"] is False` — a strict identity check against
 * the boolean `False`, so a missing/None/truthy `filtered` excludes the match.
 */
export function collectOpensearchMatchedFields(
  semanticsearchResults: unknown[] | null | undefined,
): Set<string> {
  const matched = new Set<string>();
  if (!semanticsearchResults) return matched;
  for (const searchResult of semanticsearchResults) {
    if (searchResult && typeof searchResult === "object" && "matches" in searchResult) {
      const matches = searchResult.matches;
      if (Array.isArray(matches)) {
        for (const match of matches) {
          // strict `is False` — only an actual boolean false counts.
          if (match && match.filtered === false) {
            matched.add(match.fieldName);
          }
        }
      }
    } else if (searchResult && typeof searchResult === "object") {
      matched.add((searchResult as { fieldName: string }).fieldName);
    }
  }
  return matched;
}

/**
 * SemanticSearchAccuracy: proportion of GROUNDTRUTH calc
 * fields present in the opensearch matched fields. key="formula", so the
 * expected value is the calc formula — the harness parses it into
 * `parsedExpectedFields` (a `set` in Python).
 *
 *   score = |parsed_fields ∩ matched| / |parsed_fields|,  1.0 if none expected.
 */
export function computeSemanticSearchAccuracy(ctx: MetricContext): ComputedMetric[] {
  const matched = collectOpensearchMatchedFields(ctx.semanticsearchResults);
  const parsedFields = new Set<string>(ctx.parsedExpectedFields || []);
  let score: number;
  if (parsedFields.size === 0) {
    score = 1.0;
  } else {
    let found = 0;
    for (const f of parsedFields) if (matched.has(f)) found += 1;
    score = found / parsedFields.size;
  }
  return [entry("semanticSearchAccuracy", score)];
}

/**
 * SpecSemanticSearchAccuracy: proportion of groundtruth
 * NOTIONAL-SPEC fields (find_sub_entries(expected, ["field","caption"]))
 * present in the opensearch matched fields. No `key`, so `expected` is the
 * full notionalSpec value.
 *
 * NOTE: the reference implementation emits metric_name "semanticSearchAccuracy" (a
 * copy/paste of the SemanticSearchAccuracy name — see L893), NOT the
 * "vizSemanticSearchAccuracy" label declared in metrics.json's `description`.
 * We faithfully reproduce the CODE, so we emit "semanticSearchAccuracy".
 */
export function computeSpecSemanticSearchAccuracy(ctx: MetricContext): ComputedMetric[] {
  const matched = collectOpensearchMatchedFields(ctx.semanticsearchResults);
  const expectedFields = new Set<string>(
    findSubEntries(ctx.expected, ["field", "caption"]).filter((c) => typeof c === "string"),
  );
  let score: number;
  if (expectedFields.size === 0) {
    score = 1.0;
  } else {
    let found = 0;
    for (const f of expectedFields) if (matched.has(f)) found += 1;
    score = found / expectedFields.size;
  }
  return [entry("semanticSearchAccuracy", score)];
}

/**
 * FieldRankScorer: ranx hit_rate@{1,5,10}/map/mrr over the
 * opensearch matched fields, treated as a retrieval ranking per CHUNK.
 *
 *   for search_result in semanticsearch_results:
 *       if "chunk" in search_result:
 *           chunk = search_result["chunk"]
 *           qrels[chunk] = {caption: 1 for caption in expected_fields}
 *           run.setdefault(chunk, {})
 *           for match in search_result["matches"]:
 *               if match["filtered"] is False:
 *                   run[chunk][match["fieldName"]] = match["score"]
 *   if len(qrels) == 0 or len(run) == 0: return []
 *   ranx.evaluate(qrels, Run(run), [...], make_comparable=True)
 *
 * Emits metric_name "fRank_" + metric. expected_fields are the parsed calc
 * fields (key="formula"). Only search_results that contain a `chunk` key
 * participate (flat matched fields are ignored here).
 */
export function computeFieldRankScorer(ctx: MetricContext): ComputedMetric[] {
  const metricList = ["hit_rate@1", "hit_rate@5", "hit_rate@10", "map", "mrr"];
  const expectedFields = ctx.parsedExpectedFields || [];
  const results = ctx.semanticsearchResults;

  const qrels: MultiRun = {};
  const run: MultiRun = {};
  if (results) {
    for (const searchResult of results) {
      if (searchResult && typeof searchResult === "object" && "chunk" in searchResult) {
        const chunk = searchResult.chunk as string;
        const q: QrelsForQuery = {};
        for (const caption of expectedFields) q[caption] = 1;
        qrels[chunk] = q;
        if (!(chunk in run)) run[chunk] = {};
        const matches = (searchResult as { matches?: unknown }).matches;
        if (Array.isArray(matches)) {
          for (const match of matches) {
            if (match && match.filtered === false) {
              run[chunk][match.fieldName] = match.score;
            }
          }
        }
      }
    }
  }

  // Python: `if len(qrels) == 0 or len(run) == 0: return []`. Since `run`
  // always gets a setdefault for every chunk it is empty iff qrels is empty.
  if (Object.keys(qrels).length === 0 || Object.keys(run).length === 0) return [];

  let result: Record<string, number>;
  try {
    result = irEvaluateMulti(qrels as MultiQrels, run, metricList);
  } catch (exc) {
    if (exc instanceof EmptyRunError) {
      // Mirrors ranx raising on an empty-grade qrels query (expected calc had no
      // fields). the reference would propagate; we return [] to avoid emitting a bogus
      // score. Flagged as an error path in both languages.
      return [];
    }
    throw exc;
  }
  return metricList.map((m) => entry("fRank_" + m, result[m]));
}

// ---------------------------------------------------------------------------
// CalcValidity — wraps TableauValidator.
// ---------------------------------------------------------------------------

export function computeCalcValidity(ctx: MetricContext): ComputedMetric[] {
  const validColumns: Record<string, string> = {};
  for (const f of ctx.datasourceFields || []) {
    validColumns[f.caption] = f.datatype ?? "";
  }
  const formula = (ctx.actual ?? "") as string;
  const { isValid, errors } = new TableauValidator(validColumns).validate(formula || "");

  let errorOutput: string | null = null;
  if (ctx.actual === null || ctx.actual === undefined || !String(ctx.actual).trim()) {
    errorOutput = "Empty formula";
  } else if (errors && errors.length > 0) {
    // The reference stores the list; we join for a stable string explanation.
    errorOutput = errors.join("; ");
  }
  return [entry("calcValidity", isValid ? 1.0 : 0.0, errorOutput)];
}

// ---------------------------------------------------------------------------
// ConcisenessScorer — TF-IDF + cosine over sentences.
// ---------------------------------------------------------------------------

/**
 * Extract narrative text from a JSON-markdown structure the way the reference
 * implementation does:
 * collect every "body" value in the tree, join with " ", replace newlines.
 */
export function extractContentFromMarkdown(actual: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(actual);
  } catch {
    return "";
  }
  const bodies: string[] = [];
  const walk = (data: unknown) => {
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) {
        if (k === "body") bodies.push(v as string);
        walk(v);
      }
    } else if (Array.isArray(data)) {
      for (const item of data) walk(item);
    }
  };
  walk(parsed);
  return bodies.join(" ").replace(/\n/g, " ");
}

/** Python round(x, 4) with round-half-to-even. */
function round4(x: number): number {
  const f = 1e4;
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9;
  let rounded: number;
  if (Math.abs(diff - 0.5) < EPS) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(scaled);
  return rounded / f;
}

/**
 * ConcisenessScorer._compute. Splits plain text on ". ", drops blank sentences,
 * builds the TF-IDF cosine matrix, zeroes the diagonal, and returns
 * 1 - round(mean(matrix), 4). Operates on already-extracted plain text OR on
 * markdown JSON (ctx.actual is the raw markdown string).
 */
export function computeConciseness(ctx: MetricContext): ComputedMetric[] {
  const name = "Conciseness";
  const plain = extractContentFromMarkdown((ctx.actual ?? "") as string);
  if (!plain || !plain.trim()) return [entry(name, 1.0)];
  const rawSentences = plain.split(". ");
  const filtered = rawSentences.filter((s) => s.trim());
  if (filtered.length === 0) return [entry(name, 1.0)];
  // np.fill_diagonal(sim, 0) then np.mean over ALL n*n entries. Uses the lean
  // off-diagonal accumulator (same summation order as the old matrix-then-sum,
  // so byte-identical) to avoid materializing the dense n×n matrix.
  const { sum, n } = offDiagonalSimilaritySum(filtered);
  const mean = n > 0 ? sum / (n * n) : 0;
  const score = 1 - round4(mean);
  return [entry(name, score)];
}

// ---------------------------------------------------------------------------
// ReadabilityScorer — Flesch via lib/flesch.ts (punkt substitute).
// ---------------------------------------------------------------------------

export function computeReadability(ctx: MetricContext): ComputedMetric[] {
  const name = "Readability (Flesch)";
  const plain = extractContentFromMarkdown((ctx.actual ?? "") as string);
  // readingEase already handles the <100-words -> 1.0 fallback.
  const score = readingEase(plain);
  return [entry(name, Math.max(0.0, Math.min(1.0, score)))];
}

// ---------------------------------------------------------------------------
// Color palette metrics — via lib/ciede2000.ts.
// ---------------------------------------------------------------------------

/** coefficient of variation (population, ddof=0) — scipy.stats.variation default. */
function variation(values: number[]): number {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return 0;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / n); // population std (ddof=0)
  return std / mean;
}

/** ColorPaletteDistinguishability (L2090). Only for regular palettes. */
export function computeColorPaletteDistinguishability(ctx: MetricContext): ComputedMetric[] {
  if (ctx.paletteType !== "regular") return [];
  const colors = ctx.colors || [];
  if (!colors.length) return [];
  const threshold = (ctx.config?.min_distance_threshold as number) ?? 10.0;
  const res = distinguishabilityScore(colors, threshold);
  return [entry("distinguishability", res.score)];
}

/** GradientSmoothness (L2230). For sequential + diverging palettes. */
export function computeGradientSmoothness(ctx: MetricContext): ComputedMetric[] {
  if (ctx.paletteType !== "sequential" && ctx.paletteType !== "diverging") return [];
  const colors = ctx.colors || [];
  if (!colors.length) return [];
  const labs: [number, number, number][] = [];
  for (const c of colors) {
    try {
      labs.push(hexToLab(c));
    } catch {
      /* skip invalid */
    }
  }
  if (labs.length < 2) return [entry("gradientSmoothness", 0.0)];
  const steps: number[] = [];
  for (let i = 0; i + 1 < labs.length; i++) steps.push(deltaECIE2000(labs[i], labs[i + 1]));
  if (steps.length === 1) return [entry("gradientSmoothness", 1.0)];
  const mean = steps.reduce((s, v) => s + v, 0) / steps.length;
  if (mean === 0) return [entry("gradientSmoothness", 0.0)];
  const cv = variation(steps);
  const score = Math.max(0.0, Math.min(1.0, 1.0 / (1.0 + cv)));
  return [entry("gradientSmoothness", score)];
}

/** DivergingPaletteStructure (L2325). Only for diverging palettes. */
export function computeDivergingPaletteStructure(ctx: MetricContext): ComputedMetric[] {
  if (ctx.paletteType !== "diverging") return [];
  const colors = ctx.colors || [];
  if (!colors.length) return [];
  const endpointThreshold = (ctx.config?.endpoint_distance_threshold as number) ?? 30.0;
  const midpointThreshold = (ctx.config?.midpoint_distance_threshold as number) ?? 10.0;
  const labs: [number, number, number][] = [];
  for (const c of colors) {
    try {
      labs.push(hexToLab(c));
    } catch {
      /* skip */
    }
  }
  if (labs.length < 3) return [entry("divergingStructure", 0.0)];
  const first = labs[0];
  const last = labs[labs.length - 1];
  const mid = labs[Math.floor(labs.length / 2)];
  const endpointDistance = deltaECIE2000(first, last);
  const midToFirst = deltaECIE2000(mid, first);
  const midToLast = deltaECIE2000(mid, last);
  const endpointScore = Math.min(1.0, Math.max(0.0, endpointDistance / endpointThreshold));
  const midFirstScore = Math.min(1.0, Math.max(0.0, midToFirst / midpointThreshold));
  const midLastScore = Math.min(1.0, Math.max(0.0, midToLast / midpointThreshold));
  const overall = Math.min(endpointScore, midFirstScore, midLastScore);
  return [entry("divergingStructure", overall)];
}

/** GroundTruthColorPaletteEvaluation (L2486). Matches expected->actual colors. */
export function computeGroundTruthColorPalette(ctx: MetricContext): ComputedMetric[] {
  const expectedColors: string[] = Array.isArray(ctx.expected) ? ctx.expected : [];
  if (!expectedColors.length) return [];
  const actualColors = ctx.colors || [];
  if (!actualColors.length) return [];
  const paletteType = ctx.paletteType;

  const toLab = (colors: string[]): [number, string, [number, number, number]][] => {
    const out: [number, string, [number, number, number]][] = [];
    colors.forEach((c, i) => {
      try {
        out.push([i, c, hexToLab(c)]);
      } catch {
        /* skip */
      }
    });
    return out;
  };
  const expLabs = toLab(expectedColors);
  const actLabs = toLab(actualColors);
  if (!expLabs.length || !actLabs.length) return [];

  const findClosest = (
    expLab: [number, number, number],
    used: Set<number>,
  ): [string, number, number] | null => {
    let best: string | null = null;
    let bestDist = Infinity;
    let bestIdx = -1;
    for (const [idx, color, lab] of actLabs) {
      if (used.has(idx)) continue;
      const d = deltaECIE2000(expLab, lab);
      if (d < bestDist) {
        bestDist = d;
        best = color;
        bestIdx = idx;
      }
    }
    return best !== null ? [best, bestDist, bestIdx] : null;
  };

  const matches: [string, string, number][] = [];
  const used = new Set<number>();

  if (paletteType === "sequential" || paletteType === "diverging") {
    // ordered matching
    for (const [expIdx, expColor, expLab] of expLabs) {
      let matched = false;
      if (expIdx < actLabs.length) {
        const [actIdx, actColor, actLab] = actLabs[expIdx];
        if (!used.has(actIdx)) {
          matches.push([expColor, actColor, deltaECIE2000(expLab, actLab)]);
          used.add(actIdx);
          matched = true;
        }
      }
      if (!matched) {
        const r = findClosest(expLab, used);
        if (r) {
          matches.push([expColor, r[0], r[1]]);
          used.add(r[2]);
        }
      }
    }
  } else {
    // greedy matching
    for (const [, expColor, expLab] of expLabs) {
      const r = findClosest(expLab, used);
      if (r) {
        matches.push([expColor, r[0], r[1]]);
        used.add(r[2]);
      }
    }
  }
  if (!matches.length) return [];
  const distances = matches.map((m) => m[2]);
  const avg = distances.reduce((s, v) => s + v, 0) / distances.length;
  const threshold = 10.0;
  let score = 1.0 / (1.0 + avg / threshold);
  score = Math.max(0.0, Math.min(1.0, score));
  return [entry("groundTruthValidity", score)];
}

// ---------------------------------------------------------------------------
// Numerical factuality subject relevance (fuzzy) — reused across NER metrics.
// ---------------------------------------------------------------------------

/** Sentence relevance to the subject — max over comma phrases. */
export function isSentenceRelevantToSubject(
  subject: string,
  sentence: string,
  thresholdPercent: number,
): boolean {
  const phrases = subject.split(",");
  const sentLower = sentence.toLowerCase();
  let tsr = 0;
  let pr = 0;
  for (const phrase of phrases) {
    const p = phrase.trim().toLowerCase();
    tsr = Math.max(tsr, tokenSetRatio(p, sentLower));
    pr = Math.max(pr, partialRatio(p, sentLower));
  }
  return Math.max(tsr, pr) >= thresholdPercent * 100;
}

// ---------------------------------------------------------------------------
// Registry (mirrors globals()[metric] dynamic dispatch)
// ---------------------------------------------------------------------------

export const METRIC_REGISTRY: Record<string, ComputeFn> = {
  Equals: computeEquals,
  SpecFieldAccuracy: computeSpecFieldAccuracy,
  SpecFieldValidity: computeSpecFieldValidity,
  CalcValidity: computeCalcValidity,
  CalcFieldValidity: computeCalcFieldValidity,
  CalcFieldAccuracy: computeCalcFieldAccuracy,
  CalcValueAccuracy: computeCalcValueAccuracy,
  SemanticSearchAccuracy: computeSemanticSearchAccuracy,
  SpecSemanticSearchAccuracy: computeSpecSemanticSearchAccuracy,
  FieldRankScorer: computeFieldRankScorer,
  ConcisenessScorer: computeConciseness,
  ReadabilityScorer: computeReadability,
  ColorPaletteDistinguishability: computeColorPaletteDistinguishability,
  GradientSmoothness: computeGradientSmoothness,
  DivergingPaletteStructure: computeDivergingPaletteStructure,
  GroundTruthColorPaletteEvaluation: computeGroundTruthColorPalette,
};

/**
 * Dispatch a metric by name (mirrors from_json + compute). Unknown metric
 * names throw, matching the reference's KeyError.
 */
export function computeMetric(metricName: string, ctx: MetricContext): ComputedMetric[] {
  const fn = METRIC_REGISTRY[metricName];
  if (!fn) throw new Error(`Unsupported metric: ${metricName}`);
  return fn(ctx);
}

/**
 * Metric names that require an LLM judge (Phase-3 path) — dispatched via the
 * judge module, NOT this deterministic registry. Listed here so callers know
 * which metric names to route to computeJudgeMetrics.
 */
export const JUDGE_BACKED_METRICS = [
  "LLMEvaluation",
  "NotionalSpecJudge",
  "CompatibilityCheck",
  "UnsupportedFeaturesIdentified",
  "DashboardNarrativeSemanticFactualityRate",
] as const;

/**
 * Metric names that depend on NER date detection (spaCy substitute). Their
 * compute functions accept an injectable `dateEntityDetector`. Tolerance-relaxed.
 */
export const NER_BACKED_METRICS = [
  "DashboardNarrativeNumericalRecallRate",
  "DashboardNarrativeNumericalPrecisionRate",
] as const;

export { defaultDateDetector };
export type { DateEntityDetector };
