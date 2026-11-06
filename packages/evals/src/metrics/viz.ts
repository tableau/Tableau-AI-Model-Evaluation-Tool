/**
 * The tool's visualization-quality metrics for BYOLLM notional specs.
 *
 * Deterministic viz-quality metrics on the notional-spec
 * format (chart, intent, fields[], categoricalFilters, sort). All scores are
 * floats in [0, 1]; NO LLM calls.
 *
 * Notional spec shape (relevant pieces):
 *     {
 *       chart: "bar",
 *       intent: "NLQ_TO_NOTIONAL_SPEC",
 *       fields: [
 *         { caption, encoding: "x"|"y"|"color"|..., aggregation: "default"|"sum"|...,
 *           data: "string"|"number"|"date", role: "dimension"|"measure", fieldIdentifier }
 *       ],
 *       categoricalFilters: [...],
 *       sort: {...} or fields[i].sort,
 *     }
 *
 * Rules the scores follow:
 *  - a case with no expected chart is not scored (no entries);
 *  - a chart with the right fields on swapped axes is not penalized, by Field
 *    Similarity or by Axis Accuracy, and the explanation says so;
 *  - fields match by exact name on every channel; a similar name is not a match;
 *  - a field or filter the test case marks as a wildcard (`_tb_wildcards`)
 *    matches any answer field of the same role and type, or any field;
 *  - every kind of filter counts (categorical, date range, number range,
 *    relative date), date bounds compared at the precision the case wrote;
 *  - Information Similarity reads the model's reply against the expected
 *    reply, or against a plain-English description of the expected chart.
 *
 * Scoring conventions pinned by regression fixtures:
 *  - JSON canonicalization for filter/sort equality uses a sort_keys=True
 *    equivalent (`stableJson`), matching Python's json.dumps(sort_keys=True).
 *  - sort_accuracy treats an *added* sort as a no-penalty bonus (1.0).
 *  - axis_accuracy is the swap-tolerant, encoding-or-inference set comparison.
 *  - the "expected has spec, actual has none -> all metrics 0" force path.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Spec = Record<string, unknown>;
export type Field = Record<string, unknown>;

export interface ComputedVizMetric {
  metric_id: string;
  metric_name: string;
  score: number;
  explanation: string | null;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

const _STOPWORDS = new Set<string>([
  "a", "an", "and", "the", "is", "it", "on", "in", "at", "to", "of",
  "for", "with", "as", "by", "that", "this", "was", "were", "be",
]);

/** A plain object (not null/array). */
function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Lower-case + strip non-letters, then apply a tiny Porter-style suffix
 * stripper.
 */
export function stem(name: unknown): string {
  if (!name || typeof name !== "string") return "";
  // re.sub(r"[^a-z]", " ", name.lower()) — non a-z chars (after lowering)
  // become spaces, then .strip(), then collapse-whitespace to "".
  const cleaned = name.toLowerCase().replace(/[^a-z]/g, " ").trim();
  const word = cleaned.replace(/\s+/g, "");
  const suffixes = ["ingly", "edly", "ing", "ies", "ied", "es", "ed", "ly", "s"];
  for (const suf of suffixes) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}

/** Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    const ca = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      const cb = b[j - 1];
      cur[j] = Math.min(
        prev[j] + 1, // deletion
        cur[j - 1] + 1, // insertion
        prev[j - 1] + (ca === cb ? 0 : 1), // substitution
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 0–1 semantic similarity between two field names. Exact stem match -> 1, else
 * stem + Levenshtein with a +0.1 bump if data types match.
 */
export function semanticSimilarity(
  aName: string,
  bName: string,
  aType?: string | null,
  bType?: string | null,
): number {
  if (!aName || !bName) return 0.0;
  const sa = stem(aName);
  const sb = stem(bName);
  if (sa && sa === sb) return 1.0;
  if (!sa || !sb) return 0.0;
  const dist = levenshtein(sa, sb);
  let base = Math.max(0.0, 1.0 - dist / Math.max(sa.length, sb.length));
  if (aType && bType && aType === bType) {
    base = Math.min(1.0, base + 0.1);
  }
  return base;
}

/** */
export function normalizeTextTokens(text: unknown): string[] {
  if (!text || typeof text !== "string") return [];
  // re.sub(r"[^\w\s]", "", text.lower()) — Python \w is Unicode-aware; use the
  // same property-class approach the tfidf port uses so accented/CJK survive.
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "");
  return cleaned.split(/\s+/).filter((w) => w && !_STOPWORDS.has(w));
}

/** Cosine similarity over token-frequency Counters. Mirrors `_cosine_freq`. */
export function cosineFreq(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0.0;
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  let dot = 0;
  for (const k of keys) dot += (a.get(k) ?? 0) * (b.get(k) ?? 0);
  let magA = 0;
  for (const v of a.values()) magA += v * v;
  magA = Math.sqrt(magA);
  let magB = 0;
  for (const v of b.values()) magB += v * v;
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0.0;
  return dot / (magA * magB);
}

function counter(tokens: string[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const t of tokens) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
}

function getFields(spec: unknown): Field[] {
  if (!isObj(spec)) return [];
  const fields = spec.fields;
  return Array.isArray(fields) ? fields.filter((f) => isObj(f)) : [];
}

function fieldByEncoding(fields: Field[], enc: string): Field | null {
  for (const f of fields) {
    if (f.encoding === enc) return f;
  }
  return null;
}

function fieldsByEncoding(fields: Field[], enc: string): Field[] {
  return fields.filter((f) => f.encoding === enc);
}

/**
 * Reduced representation used for deep equality on aesthetic encodings.
 * A 3-tuple (caption/id, aggregation, data).
 */
function fieldSignature(field: Field): [string, string, string] {
  return [
    String(field.caption || field.fieldIdentifier || ""),
    String(field.aggregation || "default"),
    String(field.data || ""),
  ];
}

/**
 * Deterministic JSON serialization matching Python json.dumps(sort_keys=True)
 * closely enough for the equality comparisons this module makes (filters/sort).
 * Object keys are recursively sorted; arrays keep order.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortValue(value[k]);
    }
    return out;
  }
  return value;
}

// Compare two signature tuples lexicographically (mirrors Python tuple sort).
function cmpSig(a: [string, string, string], b: [string, string, string]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function cmpSig2(a: [string, string], b: [string, string]): number {
  for (let i = 0; i < 2; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Show Me–style chart suggestions
// ---------------------------------------------------------------------------

export function showMeRecommendations(fields: Field[]): [string | null, string[]] {
  const isTime = (f: Field) => f.data === "date";
  const isQuant = (f: Field) => f.data === "number";
  const isCat = (f: Field) => f.data === "string";

  const timeFields = fields.filter(isTime).length;
  const quantMeas = fields.filter((f) => isQuant(f) && f.role === "measure").length;
  const catAll = fields.filter(isCat).length;
  const quantAll = fields.filter(isQuant).length;

  const plausible = new Set<string>();
  let best: string | null = null;

  if (timeFields >= 1 && quantMeas >= 1) {
    best = "line";
    ["line", "area", "bar"].forEach((c) => plausible.add(c));
  }
  if (catAll >= 1 && quantMeas >= 1) {
    best = best || "bar";
    ["bar", "pie", "text"].forEach((c) => plausible.add(c));
  }
  if (quantMeas >= 2) {
    best = best || "scatterplot";
    ["scatterplot", "bubble"].forEach((c) => plausible.add(c));
  }
  if (catAll === 1 && quantAll === 0) {
    best = best || "text";
    ["text", "bar"].forEach((c) => plausible.add(c));
  }
  if (quantAll === 1 && catAll === 0 && timeFields === 0) {
    best = best || "histogram";
    ["histogram", "boxplot"].forEach((c) => plausible.add(c));
  }

  if (!best) {
    best = "text";
    plausible.add("text");
  }

  return [best, Array.from(plausible).sort()];
}

// ---------------------------------------------------------------------------
// Individual metrics
// ---------------------------------------------------------------------------

/** 1 iff expected.chart == actual.chart (case-insensitive). */
export function chartTypeAccuracy(expected: Spec, actual: Spec): number {
  if (!isObj(expected) && !isObj(actual)) return 1.0;
  if (!isObj(expected) || !isObj(actual)) return 0.0;
  const e = String(expected.chart || "").toLowerCase();
  const a = String(actual.chart || "").toLowerCase();
  if (!e && !a) return 1.0;
  return e === a ? 1.0 : 0.0;
}

/** 1 if actual matches expected chart; 0.5 if Show-Me plausible; else 0. */
export function chartSimilarity(expected: Spec, actual: Spec): number {
  if (!isObj(actual)) return 0.0;
  const actualChart = String(actual.chart || "").toLowerCase();
  if (!actualChart) return 0.0;
  const expectedChart = isObj(expected) ? String(expected.chart || "").toLowerCase() : "";
  if (expectedChart && actualChart === expectedChart) return 1.0;
  const fields = expected ? getFields(expected) : getFields(actual);
  if (fields.length === 0) return 0.0;
  const [, plausible] = showMeRecommendations(fields);
  return plausible.includes(actualChart) ? 0.5 : 0.0;
}

/** A field's name as the comparison sees it: case and spacing ignored. `_caption_key`. */
function captionKey(field: Field): string {
  const cap = field.caption || field.fieldIdentifier || field.name || "";
  return String(cap).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The keys the test case marks as "any value is right" (`_tb_wildcards`,
 * written by the test bench the suites were ported from).
 */
function wildcards(obj: unknown): Set<string> {
  const w = isObj(obj) ? obj._tb_wildcards : null;
  return Array.isArray(w) ? new Set(w.map((k) => String(k))) : new Set();
}

interface FieldMatch {
  matched: [Field, Field][];
  missing: Field[];
  extra: Field[];
  swapped: [Field, Field][];
}

/**
 * Pair every expected field with an answer field by name, on every channel
 * (axes, colour, size, tooltip, …). A swapped axis is still the same field. An
 * expected field whose caption is a wildcard matches any unmatched answer
 * field of the same role and data type. Mirrors `_match_fields`.
 */
function matchFields(expected: Spec, actual: Spec): FieldMatch {
  const eFields = getFields(expected);
  const aFields = getFields(actual);
  const remaining = aFields.map((_, i) => i);
  const matched: [Field, Field][] = [];
  const missing: Field[] = [];
  const take = (pick: (f: Field) => boolean, ef: Field) => {
    const pos = remaining.findIndex((i) => pick(aFields[i]!));
    if (pos < 0) {
      missing.push(ef);
      return;
    }
    const [hit] = remaining.splice(pos, 1);
    matched.push([ef, aFields[hit!]!]);
  };
  // Named fields first, so a wildcard never steals a field that an exact name needs.
  const deferred: Field[] = [];
  for (const ef of eFields) {
    if (wildcards(ef).has("caption")) {
      deferred.push(ef);
      continue;
    }
    const key = captionKey(ef);
    take((af) => captionKey(af) === key, ef);
  }
  for (const ef of deferred) {
    const role = String(ef.role || "").toLowerCase();
    const data = String(ef.data || "").toLowerCase();
    take(
      (af) =>
        (!role || String(af.role || "").toLowerCase() === role) &&
        (!data || String(af.data || "").toLowerCase() === data),
      ef,
    );
  }
  const extra = remaining.map((i) => aFields[i]!);
  const axes = new Set<unknown>(["x", "y"]);
  const swapped = matched.filter(
    ([e, a]) => axes.has(e.encoding) && axes.has(a.encoding) && e.encoding !== a.encoding,
  );
  return { matched, missing, extra, swapped };
}

/**
 * Share of the fields that the expected chart and the answer have in common,
 * by exact name, across every channel: matched / (matched + missing + extra).
 * Swapped axes count as a match; a similar name does not.
 */
export function fieldSimilarity(expected: Spec, actual: Spec): number {
  if (!isObj(expected) && !isObj(actual)) return 1.0;
  if (!isObj(expected) || !isObj(actual)) return 0.0;
  const m = matchFields(expected, actual);
  const total = m.matched.length + m.missing.length + m.extra.length;
  if (total === 0) return 1.0;
  return m.matched.length / total;
}

/** Every list of filters a notional spec can carry. */
const FILTER_KEYS = [
  "categoricalFilters",
  "dateRangeFilters",
  "rangeFilters",
  "numericRangeFilters",
  "relativeDateFilters",
];
/** Filter keys that say nothing about what is kept (an unset bound, a default, a test-bench annotation). */
const FILTER_NOISE = new Set(["limit", "includeNull", "_tb_wildcards"]);

const DATE_RE = /^(\d{4})(?:[-\u2010\u2011\u2012\u2013](\d{1,2}))?(?:[-\u2010\u2011\u2012\u2013](\d{1,2}))?(?:[T ].*)?$/s;

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/**
 * A date bound as YYYY-MM-DD. The test cases write a month ("2023-03"), a
 * year ("2023") or a full date, sometimes with typographic hyphens and
 * sometimes with a time; the server writes full dates. A month or year means
 * its first day as a start and its last day as an end. Mirrors `_norm_date`.
 */
function normDate(value: unknown, bound: string): unknown {
  if (typeof value !== "string") return value;
  const m = DATE_RE.exec(value.trim());
  if (!m) return value.trim().toLowerCase();
  const year = Number(m[1]);
  if (m[3] !== undefined) return `${pad(year, 4)}-${pad(Number(m[2]), 2)}-${pad(Number(m[3]), 2)}`;
  if (m[2] !== undefined) {
    const month = Number(m[2]);
    // Day 0 of the next month is this month's last day (Python calendar.monthrange).
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(bound === "start" ? 1 : last, 2)}`;
  }
  return `${pad(year, 4)}-${bound === "start" ? "01-01" : "12-31"}`;
}

/** Python `v in (None, "", [], {})`. */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

interface FilterItem {
  kind: string;
  field: string;
  wildField: boolean;
  rest: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/**
 * The first and last day of the calendar period (years, quarters, months or
 * days, as the server writes them) that contains `on`. `_current_period_bounds`.
 */
function currentPeriodBounds(period: unknown, on: Date): [string, string] | null {
  const p = String(period ?? "").trim().toLowerCase().replace(/s$/, "");
  const y = on.getFullYear();
  const lastDay = (month1: number) => new Date(y, month1, 0).getDate();
  if (p === "year") return [`${pad(y, 4)}-01-01`, `${pad(y, 4)}-12-31`];
  if (p === "quarter") {
    const first = 3 * Math.floor(on.getMonth() / 3) + 1;
    const last = first + 2;
    return [`${pad(y, 4)}-${pad(first, 2)}-01`, `${pad(y, 4)}-${pad(last, 2)}-${pad(lastDay(last), 2)}`];
  }
  if (p === "month") {
    const m = on.getMonth() + 1;
    return [`${pad(y, 4)}-${pad(m, 2)}-01`, `${pad(y, 4)}-${pad(m, 2)}-${pad(lastDay(m), 2)}`];
  }
  if (p === "day") {
    const d = `${pad(y, 4)}-${pad(on.getMonth() + 1, 2)}-${pad(on.getDate(), 2)}`;
    return [d, d];
  }
  return null;
}

/** A relative date filter with amount 0: the period the run falls in ("this year"). `_is_current_period`. */
function isCurrentPeriod(f: Record<string, unknown>): boolean {
  const a = f.amount;
  if (typeof a === "number") return Number.isInteger(a) && a === 0;
  if (typeof a === "string") return /^\s*[-+]?0+\s*$/.test(a);
  return false;
}

/**
 * Every filter of a spec as one record: `kind` (the spec's filter type, or the
 * list it came from), `field` (lowercase), `wildField` (the case accepts any
 * field), `rest` (the other settings, with values sorted and lowercased so
 * order and case do not matter, and date bounds as full dates). A relative
 * date filter for the current period becomes the date range of that calendar
 * period on `referenceDate` (today when not given): "this year" is the same
 * filter either way the server writes it. `_filter_items`.
 */
function filterItems(spec: Spec, referenceDate?: Date | null): FilterItem[] {
  const items: FilterItem[] = [];
  if (!isObj(spec)) return items;
  for (const key of FILTER_KEYS) {
    const list = spec[key];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!isObj(f)) continue;
      let kind = String(f.type || key).toLowerCase();
      let rest: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(f)) {
        if (FILTER_NOISE.has(k) || k === "field" || k === "type" || isBlank(raw)) continue;
        let v: unknown = raw;
        if (Array.isArray(raw)) v = raw.map((x) => pyStr(x).trim().toLowerCase()).sort(pyCmp);
        else if ((k === "start" || k === "end") && kind.includes("date")) v = normDate(raw, k);
        else if (typeof raw === "string") v = raw.trim().toLowerCase();
        rest[k] = v;
      }
      if (kind === "relative-date" && isCurrentPeriod(f)) {
        const bounds = currentPeriodBounds(f.period, referenceDate ?? new Date());
        if (bounds) {
          kind = "date-range";
          rest = { start: bounds[0], end: bounds[1] };
        }
      }
      items.push({
        kind,
        field: String(f.field || "").trim().toLowerCase(),
        wildField: wildcards(f).has("field"),
        rest,
        raw: f,
      });
    }
  }
  return items;
}

interface FilterMatch {
  matched: [FilterItem, FilterItem][];
  missing: FilterItem[];
  extra: FilterItem[];
}

/**
 * Pair expected filters with answer filters: same kind, same field (or any
 * field when the case says so) and the same settings. `_match_filters`.
 */
function matchFilters(expected: Spec, actual: Spec, referenceDate?: Date | null): FilterMatch {
  const eItems = filterItems(expected, referenceDate);
  const aItems = filterItems(actual, referenceDate);
  const remaining = aItems.map((_, i) => i);
  const matched: [FilterItem, FilterItem][] = [];
  const missing: FilterItem[] = [];
  for (const ef of eItems) {
    const pos = remaining.findIndex((i) => {
      const a = aItems[i]!;
      return (
        a.kind === ef.kind && (ef.wildField || a.field === ef.field) && stableJson(a.rest) === stableJson(ef.rest)
      );
    });
    if (pos < 0) {
      missing.push(ef);
    } else {
      const [hit] = remaining.splice(pos, 1);
      matched.push([ef, aItems[hit!]!]);
    }
  }
  return { matched, missing, extra: remaining.map((i) => aItems[i]!) };
}

/**
 * Share of the filters the expected chart and the answer have in common, over
 * every kind of filter: matched / (matched + missing + extra). No filter on
 * either side is a match.
 */
export function filterAccuracy(expected: Spec, actual: Spec, referenceDate?: Date | null): number {
  if (!isObj(expected) && !isObj(actual)) return 1.0;
  if (!isObj(expected) || !isObj(actual)) return 0.0;
  const m = matchFilters(expected, actual, referenceDate);
  const total = m.matched.length + m.missing.length + m.extra.length;
  if (total === 0) return 1.0;
  return m.matched.length / total;
}

/** Python `str(x)` for a JSON scalar inside a filter's value list. */
function pyStr(x: unknown): string {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (typeof x === "number") return String(x);
  if (typeof x === "string") return x;
  return JSON.stringify(x);
}

/** Python `sorted()` order for str: by code point. */
function pyCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Notional specs may carry sort at top level or as a sort key on a field.
 * Return a stable JSON-serializable representation. Mirrors `_extract_sort`.
 */
function extractSort(spec: Spec): unknown {
  if (!isObj(spec)) return null;
  if (Object.prototype.hasOwnProperty.call(spec, "sort")) return spec.sort;
  const sorts: unknown[] = [];
  for (const f of getFields(spec)) {
    if (Object.prototype.hasOwnProperty.call(f, "sort") && f.sort !== null && f.sort !== undefined) {
      sorts.push({ caption: f.caption, sort: f.sort });
    }
  }
  return sorts.length ? sorts : null;
}

/**
 * Score whether the model's sort matches the expected sort. An *added* sort
 * (expected none, actual added one) is a no-penalty bonus (1.0).
 *
 * Note the Python `if e is None and a is None` treats `None` specifically;
 * we mirror by mapping absent-sort to `null` (extractSort returns null).
 */
export function sortAccuracy(expected: Spec, actual: Spec): number {
  const e = extractSort(expected);
  const a = extractSort(actual);
  const eNone = e === null || e === undefined;
  const aNone = a === null || a === undefined;
  if (eNone && aNone) return 1.0; // neither specified — vacuously correct
  if (eNone && !aNone) return 1.0; // added sort — helpful, not wrong
  if (!eNone && aNone) return 0.0; // missed an expected sort
  try {
    return stableJson(e) === stableJson(a) ? 1.0 : 0.0;
  } catch {
    return 0.0;
  }
}

/** Field on a given axis matches by (caption/id) and aggregation. `_axis_match`. */
function axisMatch(expected: Spec, actual: Spec, axis: string): number {
  const e = fieldByEncoding(getFields(expected), axis);
  const a = fieldByEncoding(getFields(actual), axis);
  if (!e && !a) return 1.0;
  if (!e || !a) return 0.0;
  const eId = String(e.caption || e.fieldIdentifier || "").toLowerCase();
  const aId = String(a.caption || a.fieldIdentifier || "").toLowerCase();
  if (eId !== aId) return 0.0;
  const eAgg = String(e.aggregation || "default").toLowerCase();
  const aAgg = String(a.aggregation || "default").toLowerCase();
  return eAgg === aAgg ? 1.0 : 0.0;
}

/** Back-compat, not emitted as a scored metric. */
export function axisXAccuracy(expected: Spec, actual: Spec): number {
  return axisMatch(expected || {}, actual || {}, "x");
}

/** Back-compat, not emitted as a scored metric. */
export function axisYAccuracy(expected: Spec, actual: Spec): number {
  return axisMatch(expected || {}, actual || {}, "y");
}

/** Reduced (caption, aggregation) signature for one axis field. `_axis_field_signature`. */
function axisFieldSignature(field: Field | null): [string, string] | null {
  if (!field) return null;
  const cap = String(field.caption || field.fieldIdentifier || "").toLowerCase();
  const agg = String(field.aggregation || "default").toLowerCase();
  return [cap, agg];
}

/**
 * Return (x_field, y_field) honoring explicit encoding keys first, then
 * role/data inference, then positional fallback. Mirrors `_get_axis_fields`.
 * Uses object identity (Set of references) to track "used" fields, matching
 * Python's `id(f)`.
 */
function getAxisFields(spec: Spec): [Field | null, Field | null] {
  const fields = getFields(spec);
  let x = fieldByEncoding(fields, "x");
  let y = fieldByEncoding(fields, "y");
  if (x && y) return [x, y];

  const used = new Set<Field>();
  if (x !== null) used.add(x);
  if (y !== null) used.add(y);

  const eligible = (f: Field): boolean => {
    if (used.has(f)) return false;
    const enc = f.encoding;
    return enc === null || enc === undefined || enc === "" || enc === "x" || enc === "y";
  };

  const candidates = fields.filter((f) => eligible(f));

  // Step 2 — role-based inference.
  if (x === null) {
    for (const f of candidates) {
      if (used.has(f)) continue;
      const role = String(f.role || "").toLowerCase();
      const data = String(f.data || "").toLowerCase();
      if (role === "dimension" || data === "string" || data === "date") {
        x = f;
        used.add(f);
        break;
      }
    }
  }
  if (y === null) {
    for (const f of candidates) {
      if (used.has(f)) continue;
      const role = String(f.role || "").toLowerCase();
      const data = String(f.data || "").toLowerCase();
      if (role === "measure" || data === "number") {
        y = f;
        used.add(f);
        break;
      }
    }
  }

  // Step 3 — positional fallback.
  if (x === null) {
    for (const f of candidates) {
      if (used.has(f)) continue;
      x = f;
      used.add(f);
      break;
    }
  }
  if (y === null) {
    for (const f of candidates) {
      if (used.has(f)) continue;
      y = f;
      used.add(f);
      break;
    }
  }

  return [x, y];
}

/** Unified swap-tolerant axis metric. */
export function axisAccuracy(expected: Spec, actual: Spec): number {
  if (!isObj(expected) && !isObj(actual)) return 1.0;
  if (!isObj(expected) || !isObj(actual)) return 0.0;

  const [eX, eY] = getAxisFields(expected);
  const [aX, aY] = getAxisFields(actual);
  const eSigs = [axisFieldSignature(eX), axisFieldSignature(eY)];
  const aSigs = [axisFieldSignature(aX), axisFieldSignature(aY)];
  const ePresent = eSigs.filter((s): s is [string, string] => s !== null);
  const aPresent = aSigs.filter((s): s is [string, string] => s !== null);

  if (ePresent.length === 0 && aPresent.length === 0) return 1.0;
  if (ePresent.length === 0 || aPresent.length === 0) return 0.0;

  const eSorted = [...ePresent].sort(cmpSig2);
  const aSorted = [...aPresent].sort(cmpSig2);
  if (
    eSorted.length === aSorted.length &&
    eSorted.every((s, i) => cmpSig2(s, aSorted[i]) === 0)
  ) {
    return 1.0;
  }

  // Partial credit: multiset intersection count.
  const remaining = [...aPresent];
  let matched = 0;
  for (const s of ePresent) {
    const idx = remaining.findIndex((r) => cmpSig2(r, s) === 0);
    if (idx >= 0) {
      remaining.splice(idx, 1);
      matched += 1;
    }
  }
  return matched / Math.max(ePresent.length, aPresent.length);
}

const AESTHETIC_CHANNELS = ["color", "shape", "opacity", "text", "size"] as const;

/** 1 iff aesthetic-channel field sets match. Mirrors `aesthetic_accuracy`. */
export function aestheticAccuracy(expected: Spec, actual: Spec): number {
  if (!isObj(expected) && !isObj(actual)) return 1.0;
  if (!isObj(expected) || !isObj(actual)) return 0.0;
  const ef = getFields(expected);
  const af = getFields(actual);
  for (const ch of AESTHETIC_CHANNELS) {
    const eSigs = fieldsByEncoding(ef, ch).map(fieldSignature).sort(cmpSig);
    const aSigs = fieldsByEncoding(af, ch).map(fieldSignature).sort(cmpSig);
    if (
      eSigs.length !== aSigs.length ||
      !eSigs.every((s, i) => cmpSig(s, aSigs[i]) === 0)
    ) {
      return 0.0;
    }
  }
  return 1.0;
}

/** Compare tooltip-encoded fields by reduced signature set. */
export function tooltipAccuracy(expected: Spec, actual: Spec): number {
  if (!isObj(expected) && !isObj(actual)) return 1.0;
  if (!isObj(expected) || !isObj(actual)) return 0.0;
  const e = fieldsByEncoding(getFields(expected), "tooltip").map(fieldSignature).sort(cmpSig);
  const a = fieldsByEncoding(getFields(actual), "tooltip").map(fieldSignature).sort(cmpSig);
  if (e.length !== a.length) return 0.0;
  return e.every((s, i) => cmpSig(s, a[i]) === 0) ? 1.0 : 0.0;
}

/** Cosine similarity over normalized word-freq vectors of two NL replies. */
export function informationSimilarity(expectedReply: string, actualReply: string): number {
  if (!expectedReply || !actualReply) return 0.0;
  const a = counter(normalizeTextTokens(expectedReply));
  const b = counter(normalizeTextTokens(actualReply));
  return cosineFreq(a, b);
}

/**
 * A notional spec in plain English: the words a reply about this chart would
 * use. When a side has no written reply, its chart is described instead, so
 * the model's reply can be read against the expected chart. Mirrors
 * `describe_spec`.
 */
export function describeSpec(spec: Spec): string {
  if (!isObj(spec)) return "";
  const parts: string[] = [];
  const chart = String(spec.chart || "").trim();
  if (chart) parts.push(`A ${chart} chart.`);
  const fields = getFields(spec);
  const [x, y] = getAxisFields(spec);
  if (x) parts.push(`The x-axis shows ${fmtFieldCaption(x)}.`);
  if (y) parts.push(`The y-axis shows ${fmtFieldCaption(y)}.`);
  const channelWords: Record<string, string> = {
    color: "Color",
    size: "Size",
    shape: "Shape",
    text: "Text",
    tooltip: "The tooltip",
    opacity: "Opacity",
    detail: "Detail",
  };
  for (const f of fields) {
    const enc = f.encoding;
    if (typeof enc === "string" && Object.hasOwn(channelWords, enc) && f !== x && f !== y) {
      parts.push(`${channelWords[enc]} shows ${fmtFieldCaption(f)}.`);
    }
  }
  for (const item of filterItems(spec)) parts.push(`Filtered to ${fmtFilter(item)}.`);
  const sort = extractSort(spec);
  if (isObj(sort)) {
    const by = sort.by || sort.field;
    const direction = sort.direction || sort.order;
    if (by) parts.push(`Sorted by ${by}${direction ? ` ${direction}` : ""}.`);
  }
  return parts.join(" ");
}

function explainInformationSimilarity(score: number, expectedFromReply: boolean, actualFromReply: boolean): string {
  const eSide = expectedFromReply ? "the expected reply" : "a description of the expected chart";
  const aSide = actualFromReply ? "the model's reply" : "a description of the model's chart";
  return `Word overlap between ${aSide} and ${eSide}: ${pct0(score)}.`;
}

// ---------------------------------------------------------------------------
// Per-metric prose explanations
// ---------------------------------------------------------------------------

/** Short human label for one field, e.g. "Sales (sum)" or "Year". */
function fmtFieldCaption(f: Field): string {
  const cap = f.caption || f.name || "?";
  const agg = f.aggregation;
  if (agg && agg !== "default") return `${cap} (${agg})`;
  return String(cap);
}

/**
 * Python-style `f"{x:.0%}"` — multiply by 100 and format with 0 decimals.
 * Python's format uses round-half-to-even (banker's rounding), e.g.
 * 0.125 -> "12%", 0.005 -> "0%". We reproduce that here.
 */
function pct0(x: number): string {
  const scaled = x * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  const EPS = 1e-9;
  if (Math.abs(diff - 0.5) < EPS) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return `${rounded}%`;
}

function explainMetric(
  name: string,
  expected: Spec,
  actual: Spec,
  score: number,
  referenceDate?: Date | null,
): string | null {
  const e: Spec = isObj(expected) ? expected : {};
  const a: Spec = isObj(actual) ? actual : {};
  const perfect = score >= 0.99;

  if (name === "chartSimilarity") {
    const eChart = String(e.chart || "?").trim();
    const aChart = String(a.chart || "?").trim();
    if (perfect) return `Chart family matches ('${eChart}').`;
    return `Different chart family — expected '${eChart}', got '${aChart}'.`;
  }

  if (name === "fieldSimilarity") {
    const m = matchFields(e, a);
    const matched = m.matched.map(([ef]) => fmtFieldCaption(ef));
    let swap = "";
    if (m.swapped.length) {
      const names = m.swapped.map(([ef]) => fmtFieldCaption(ef)).join(", ");
      swap = ` X and Y are swapped for ${names} (not penalized).`;
    }
    if (perfect) {
      if (!matched.length) return "No fields expected and none produced.";
      return `Every field matches by name on every channel: ${matched.join(", ")}.${swap}`;
    }
    const parts: string[] = [];
    if (m.missing.length) parts.push("missing: " + m.missing.map(fmtFieldCaption).join(", "));
    if (m.extra.length) parts.push("extra: " + m.extra.map(fmtFieldCaption).join(", "));
    const head = `Matched ${matched.length} of ${matched.length + m.missing.length} expected fields by name`;
    const tail = parts.length ? ` (${parts.join("; ")})` : "";
    return `${head}${tail}.${swap} A similar name is not a match.`;
  }

  if (name === "filterAccuracy") {
    const m = matchFilters(e, a, referenceDate);
    if (perfect) {
      if (!m.matched.length) return "No filters expected and none produced.";
      return "Filters match: " + m.matched.map(([ef]) => fmtFilter(ef)).join("; ") + ".";
    }
    const parts: string[] = [];
    if (m.missing.length) parts.push("missing: " + m.missing.map(fmtFilter).join("; "));
    if (m.extra.length) parts.push("extra: " + m.extra.map(fmtFilter).join("; "));
    return (
      `Matched ${m.matched.length} of ${m.matched.length + m.missing.length} expected filters` +
      (parts.length ? ` (${parts.join(" \u2014 ")})` : "") +
      "."
    );
  }

  if (name === "sortAccuracy") {
    const eSort = extractSort(e);
    const aSort = extractSort(a);
    const eNone = eSort === null || eSort === undefined;
    const aNone = aSort === null || aSort === undefined;
    if (perfect) {
      if (eNone && aNone) return "No sort expected; none produced.";
      if (eNone && !aNone) return "Sort added by model (not required, not penalized).";
      return "Sort order matches expected.";
    }
    if (!eNone && aNone) return "Expected a sort, model produced none.";
    return "Sort order differs from expected.";
  }

  if (name === "axisAccuracy") {
    const [eX, eY] = getAxisFields(e);
    const [aX, aY] = getAxisFields(a);
    const eXLbl = eX ? fmtFieldCaption(eX) : "(none)";
    const eYLbl = eY ? fmtFieldCaption(eY) : "(none)";
    const aXLbl = aX ? fmtFieldCaption(aX) : "(none)";
    const aYLbl = aY ? fmtFieldCaption(aY) : "(none)";
    if (perfect) {
      // Detect the swapped-but-correct case so the tooltip is honest about it.
      // Same set, different positions = swap. An empty axis slot is left out.
      const present = (xs: ([string, string] | null)[]) =>
        xs.filter((v): v is [string, string] => v !== null).sort(cmpSig2);
      const eSet = present([axisFieldSignature(eX), axisFieldSignature(eY)]);
      const aSet = present([axisFieldSignature(aX), axisFieldSignature(aY)]);
      const samePositions =
        eqMaybe(axisFieldSignature(eX), axisFieldSignature(aX)) &&
        eqMaybe(axisFieldSignature(eY), axisFieldSignature(aY));
      const setsEqual = eSet.length === aSet.length && eSet.every((v, i) => cmpSig2(v, aSet[i]!) === 0);
      if (setsEqual && !samePositions) {
        return `Axis fields match, with X and Y swapped (not penalized): X=${aXLbl}, Y=${aYLbl}.`;
      }
      return `Axis fields match: X=${eXLbl}, Y=${eYLbl}.`;
    }
    if (score > 0) {
      return (
        `One axis field matches, one differs \u2014 expected X=${eXLbl}, Y=${eYLbl}; ` +
        `got X=${aXLbl}, Y=${aYLbl}. A swap of X and Y would not be penalized.`
      );
    }
    return `Axis fields differ \u2014 expected X=${eXLbl}, Y=${eYLbl}; got X=${aXLbl}, Y=${aYLbl}.`;
  }

  if (name === "aestheticAccuracy") {
    const ef = getFields(e);
    const af = getFields(a);
    const diffs: string[] = [];
    for (const ch of AESTHETIC_CHANNELS) {
      const eSigs = fieldsByEncoding(ef, ch).map(fieldSignature).sort(cmpSig);
      const aSigs = fieldsByEncoding(af, ch).map(fieldSignature).sort(cmpSig);
      const equal =
        eSigs.length === aSigs.length && eSigs.every((s, i) => cmpSig(s, aSigs[i]) === 0);
      if (equal) continue;
      if (eSigs.length && !aSigs.length) diffs.push(`missing ${ch}`);
      else if (aSigs.length && !eSigs.length) diffs.push(`extra ${ch}`);
      else diffs.push(`different ${ch}`);
    }
    if (perfect || diffs.length === 0) return "All aesthetic channels match.";
    return "Aesthetic channels — " + diffs.join(", ") + ".";
  }

  if (name === "tooltipAccuracy") {
    if (perfect) return "Tooltip-encoded fields match.";
    return "Tooltip-encoded fields differ from expected.";
  }

  return null;
}

/**
 * 'Opportunity Owner Division = Sales - Southeast', 'Close Date between
 * 2026-03-01 and 2026-06-30', 'Close Date in the previous 1 quarters',
 * 'sum of Line Item Value up to 450000000'. Mirrors `_fmt_filter`.
 */
function fmtFilter(item: FilterItem): string {
  const f = item.raw;
  const field = f.field || (item.wildField ? "any field" : "?");
  const kind = String(f.type || item.kind).toLowerCase();
  if (kind === "categorical" || kind === "categoricalfilters") {
    const raw = f.values;
    const vals = Array.isArray(raw) ? raw.map(pyStr).join(", ") : raw ? pyStr(raw) : "";
    return vals ? `${field} = ${vals}` : `${field} (categorical)`;
  }
  if (kind === "relative-date" || kind === "relativedatefilters") {
    if (isCurrentPeriod(f)) return `${field} in the current ${String(f.period || "period").replace(/s$/, "")}`;
    return `${field} in the ${f.direction || ""} ${f.amount || ""} ${f.period || ""}`.replaceAll("  ", " ").trim();
  }
  const agg = f.aggregation;
  const subject = agg && agg !== "default" ? `${agg} of ${field}` : field;
  const start = f.start ?? null;
  const end = f.end ?? null;
  if (start !== null && end !== null) return `${subject} between ${pyStr(start)} and ${pyStr(end)}`;
  if (start !== null) return `${subject} from ${pyStr(start)}`;
  if (end !== null) return `${subject} up to ${pyStr(end)}`;
  return `${subject} (${kind})`;
}

// None-aware helpers mirroring Python sorted()/== on lists that may hold None.
function eqMaybe(a: [string, string] | null, b: [string, string] | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return cmpSig2(a, b) === 0;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export const VIZ_STAGE = "vizQuality";
const METRIC_ID = "VizQuality";

function entry(name: string, score: number | null, explanation: string | null = null): ComputedVizMetric {
  let s = score === null || score === undefined ? 0.0 : Number(score);
  s = Math.max(0.0, Math.min(1.0, s));
  return {
    metric_id: METRIC_ID,
    metric_name: name,
    score: s,
    explanation,
  };
}

export interface ComputeToolMetricsOptions {
  expectedReply?: string | null;
  actualReply?: string | null;
  /** The chart that stands when the answer has none: the previous turn's,
   *  which the server leaves on screen when it answers a follow-up with no
   *  chart definition. Compared in the answer's place, and every chart
   *  explanation says so. */
  carriedSpec?: Spec | null;
  /** The day the run was made, for relative date filters (today when not given). */
  referenceDate?: Date | null;
}

/**
 * Compute all the tool's viz-quality metrics on a pair of {notionalSpec} wrappers.
 *
 */
export function computeToolMetrics(
  expected: Spec | null | undefined,
  actual: Spec | null | undefined,
  opts: ComputeToolMetricsOptions = {},
): ComputedVizMetric[] {
  const expectedReply = opts.expectedReply ?? null;
  const actualReply = opts.actualReply ?? null;
  const referenceDate = opts.referenceDate ?? null;

  const eSpec = isObj(expected) ? (expected.notionalSpec ?? null) : null;
  let aSpec = isObj(actual) ? (actual.notionalSpec ?? null) : null;

  // No expected chart: nothing to score against. A calculation case has none,
  // and so do the suite's cases that ship without one (the caller says so on
  // the case). Scoring the answer against an empty chart used to hand out
  // vacuous perfect sort, aesthetic and tooltip scores.
  if (!isObj(eSpec)) return [];

  let unchanged = false;
  if (!isObj(aSpec) && isObj(opts.carriedSpec)) {
    aSpec = opts.carriedSpec;
    unchanged = true;
  }

  let chartMetricNames = [
    "chartSimilarity",
    "fieldSimilarity",
    "filterAccuracy",
    "sortAccuracy",
    "axisAccuracy",
    "aestheticAccuracy",
    "tooltipAccuracy",
  ];
  // A case that names no chart family accepts any family, so there is no
  // family to compare: Chart Similarity is not scored for it.
  if (!String(eSpec.chart ?? "").trim()) chartMetricNames = chartMetricNames.filter((n) => n !== "chartSimilarity");

  const metrics = chartMetrics(eSpec, aSpec, chartMetricNames, referenceDate);
  if (unchanged) {
    for (const m of metrics) m.explanation = `${UNCHANGED_CHART_NOTE} ${m.explanation ?? ""}`.trim();
  }
  metrics.push(informationEntry(eSpec, isObj(aSpec) ? aSpec : null, expectedReply, actualReply));
  return metrics;
}

/** The chart metrics named in `names`, in that order. Mirrors `_chart_metrics`. */
function chartMetrics(eSpec: Spec, aSpec: unknown, names: string[], referenceDate: Date | null): ComputedVizMetric[] {
  // The model produced no spec at all: every chart metric is 0, so the
  // failure is visible end-to-end.
  if (!isObj(aSpec)) return names.map((name) => entry(name, 0.0, NO_SPEC_EXPLANATION));

  // The model's spec has no fields: there is no chart, only (perhaps) a
  // filter. Every chart metric is 0; the filter is still compared, since a
  // filter can be right without a chart. (An expected chart with no fields is
  // a suite defect and is compared as it is.)
  if (getFields(eSpec).length && !getFields(aSpec).length) {
    return names.map((name) => {
      if (name !== "filterAccuracy") return entry(name, 0.0, NO_FIELDS_EXPLANATION);
      const fScore = filterAccuracy(eSpec, aSpec, referenceDate);
      return entry(name, fScore, explainMetric(name, eSpec, aSpec, fScore, referenceDate));
    });
  }

  const scorers: Record<string, () => number> = {
    chartSimilarity: () => chartSimilarity(eSpec, aSpec),
    fieldSimilarity: () => fieldSimilarity(eSpec, aSpec),
    filterAccuracy: () => filterAccuracy(eSpec, aSpec, referenceDate),
    sortAccuracy: () => sortAccuracy(eSpec, aSpec),
    axisAccuracy: () => axisAccuracy(eSpec, aSpec),
    aestheticAccuracy: () => aestheticAccuracy(eSpec, aSpec),
    tooltipAccuracy: () => tooltipAccuracy(eSpec, aSpec),
  };
  return names.map((name) => {
    const score = scorers[name]!();
    return entry(name, score, explainMetric(name, eSpec, aSpec, score, referenceDate));
  });
}

export const NO_SPEC_EXPLANATION = "The model did not produce a chart, so there is nothing to compare.";
/** The sentence every chart explanation starts with when the previous turn's
 *  chart was compared because the answer carried none. */
export const UNCHANGED_CHART_NOTE = "The model left the chart as it was, so the chart from the previous turn is compared.";
/** Where an answer that changed nothing records the chart that stands (the
 *  previous turn's), for the results page and the exports. */
export const UNCHANGED_CHART_KEY = "unchanged_chart";
export const NO_FIELDS_EXPLANATION = "The model's chart has no fields, so there is no chart to compare.";
/**
 * The warning a chart case carries when the suite ships it without an
 * expected chart: nothing to score the answer against. The export reads it to
 * mark the case unscored.
 */
export const NO_EXPECTED_CHART_WARNING =
  "This test case has no expected chart in the suite, so the model's chart " +
  "was not scored; only the request type and the judge's view of the reply are.";

/**
 * Information Similarity: the model's reply (or, without one, a description
 * of its chart) against the expected reply (or, without one, a description of
 * the expected chart). Mirrors `_information_entry`.
 */
function informationEntry(
  eSpec: Spec | null,
  aSpec: Spec | null,
  expectedReply: string | null,
  actualReply: string | null,
): ComputedVizMetric {
  const eText = expectedReply || describeSpec(eSpec || {});
  const aText = actualReply || describeSpec(aSpec || {});
  const score = informationSimilarity(eText, aText);
  return entry(
    "informationSimilarity",
    score,
    explainInformationSimilarity(score, Boolean(expectedReply), Boolean(actualReply)),
  );
}
