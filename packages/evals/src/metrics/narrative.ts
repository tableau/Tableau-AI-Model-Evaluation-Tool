/** Dashboard Narratives deterministic metrics.
 * Date filtering uses dependency-free regex detection. */
import type { MetricEntry } from "@tableau-ai-eval/core";
import { countWordSyllables, fleschScore } from "./lib/flesch.ts";
import { partialRatio, tokenSetRatio } from "./lib/fuzzy.ts";
import { offDiagonalSimilaritySum } from "./lib/tfidf.ts";

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const names = [
  "Readability (Flesch)",
  "Conciseness",
  "OUTLIERS Numerical Factuality Recall Rate",
  "PULSE_INSIGHTS Numerical Factuality Recall Rate",
  "Numerical Factuality Precision Rate",
];
const ids = [
  "84db44e5351d44168a5f03bfb22bb046",
  "315dd8140602d7ca5fac9840ae6b66b7",
  "77508b0adefe8d4f7f87206d7365a5a2",
  "65e22c1c4f1a209171c840a3e022bd65",
  "d984fcd33dbd07d436e8fe7d5b53e63e",
];

function entry(i: number, score: number, explanation: string | null): MetricEntry {
  return { metric_id: ids[i], metric_name: names[i], score, explanation };
}

/** Python round(x, 4), including its round-half-to-even rule. */
export function round4(x: number): number {
  const scaled = x * 10000;
  const floor = Math.floor(scaled);
  return (Math.abs(scaled - floor - 0.5) < 1e-9 ? floor + (floor % 2) : Math.round(scaled)) / 10000;
}

/** Section bodies are scored; headings and layout metadata are not prose. */
export function summaryText(actual: unknown): string {
  let doc = actual;
  if (typeof actual === "string") {
    try {
      doc = JSON.parse(actual);
    } catch {
      return actual.replace(/\n/g, " ");
    }
  }
  const bodies: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else
      for (const [key, value] of Object.entries(object(node))) {
        if (key === "body") bodies.push(String(value));
        walk(value);
      }
  };
  walk(doc);
  return (bodies.length ? bodies.join(" ") : typeof doc === "string" ? doc : "").replace(
    /\n/g,
    " ",
  );
}

export function proseOnly(text: string): string {
  return text
    .replace(/[$€£]?\s?[-+]?\d[\d,]*(?:\.\d+)?\s?(?:%|[KMBT]\b|km\b|kg\b|hrs?\b|min\b|s\b)?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Readability uses the standalone tokenizer, not the old nltk
// substitute: remove figures and normalize Flesch against plain English (60).
function readability(actual: unknown): MetricEntry {
  const prose = proseOnly(summaryText(actual));
  const words = (
    prose.match(/[\p{L}\p{N}_'’]+(?:[-.][\p{L}\p{N}_'’]+)*|[^\p{L}\p{N}_\s]+/gu) || []
  ).filter((t) => !/^[.,\/#!$%'\^&*;:{}=\-_`~()]$/.test(t));
  if (words.length < 100)
    return entry(0, 1, "Fewer than 100 words of prose: too short to rate, counted as readable.");
  let sentences = 0;
  let start = 0;
  for (const m of prose.matchAll(/([.!?]+["”’)\]]*)[,;]?\s+(?=[^a-z\s])/g)) {
    if (prose.slice(start, m.index + m[1].length).trim()) sentences++;
    start = m.index + m[0].length;
  }
  if (prose.slice(start).trim()) sentences++;
  const flesch = fleschScore({
    numWords: words.length,
    numSentences: sentences,
    numSyllables: words.reduce((s, w) => s + countWordSyllables(w), 0),
  });
  return entry(
    0,
    round4(Math.max(0, Math.min(1, flesch / 60))),
    `Flesch Reading Ease ${flesch.toFixed(1)} on the summary's prose (figures left out); 60 and above counts as plain English and scores 1.0.`,
  );
}

// Numbers: extract scaled values first, then unscaled values outside those
// spans. Dates are excluded using the reference regex patterns.
const dateRegex =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+\d{4})?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+\d{4})?\b|\b(?:q[1-4]|fy|h[12])\s?'?\d{2,4}\b|\b(?:19|20)\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi;
const scaledRegex =
  /(?:^|[\s([{\$€£¥₹])(-?\d{1,3}(?:[ ,]?\d{3})*(?:\.\d+)?)\s*([kmbt]|thousands?|millions?|billions?|trillions?)(?=[\s)\]},.;%]|$)/gi;
const numberRegex =
  /(?<=[\s([{\$€£¥₹])-?\d{1,3}(?:[ ,]?\d{3})*(?:\.\d+)?(?=[\s)\]},.;%]|$|[a-zA-Z])/g;
const scales: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  thousands: 1e3,
  m: 1e6,
  million: 1e6,
  millions: 1e6,
  b: 1e9,
  billion: 1e9,
  billions: 1e9,
  t: 1e12,
  trillion: 1e12,
  trillions: 1e12,
};

export function normalizeNarrativeNumber(value: string): string {
  const scaled = /(\d+(?:\.\d+)?)\s*([KMBT])/i.exec(value);
  if (scaled) return String(Number(scaled[1]) * scales[scaled[2].toLowerCase()]);
  const clean = value.replace(/[ ,]/g, "");
  const match = /[-+]?\d*\.\d+|\d+/.exec(clean);
  return match ? String(Number(match[0])) : clean;
}

export function extractNarrativeNumbers(text: string, structured = false): string[] {
  if (!text?.trim()) return [];
  text = text.trim();
  if (/^-?[\d,]+\.?\d*$/.test(text)) return structured ? [] : [text];
  const dates = [...text.matchAll(dateRegex)].map((m) => [m.index, m.index + m[0].length]);
  const inside = (m: RegExpMatchArray, spans: number[][]) =>
    spans.some(([s, e]) => m.index! >= s && m.index! + m[0].length <= e);
  const positions: number[][] = [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const n = normalizeNarrativeNumber(raw);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(raw);
    }
  };
  for (const m of text.matchAll(scaledRegex)) {
    if (inside(m, dates)) continue;
    const n = m[1].replace(/[ ,]/g, "");
    const scale = m[2].toLowerCase().trim();
    if (structured) out.push(String(Number(n) * (scales[scale] || 1)));
    else add(`${n} ${scale}`);
    positions.push([m.index, m.index + m[0].length]);
  }
  if (structured) return out;
  for (const m of text.matchAll(numberRegex))
    if (!inside(m, dates) && !inside(m, positions)) add(m[0]);
  return out;
}

function approximatelyEqual(a: string, b: string): boolean {
  const x = Number(a.replace(/[ ,]/g, ""));
  const y = Number(b.replace(/[ ,]/g, ""));
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    (x === 0 || y === 0
      ? Math.abs(x - y) < 1
      : (Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y))) * 100 <= 1)
  );
}

const relevanceCache = new Map<string, boolean>();

function relevant(subject: string, sentence: string): boolean {
  const key = JSON.stringify([subject, sentence]);
  const cached = relevanceCache.get(key);
  if (cached !== undefined) return cached;
  const lower = sentence.toLowerCase();
  const result = String(subject)
    .split(",")
    .some((phrase) => {
      const p = phrase.trim().toLowerCase();
      // Only the threshold matters. Avoid the costlier sliding-window ratio
      // when the token-set comparison has already established relevance.
      return tokenSetRatio(p, lower) >= 45 || partialRatio(p, lower) >= 45;
    });
  relevanceCache.set(key, result);
  return result;
}

function artifactItems(artifact: Obj): Obj[] {
  try {
    return list(JSON.parse(String(artifact.artifact || "[]"))).map(object);
  } catch {
    return [];
  }
}

const clean = (v: unknown) => String(v).replace(/[\t\n\r]/g, " ");

/** Recall counts artifact numbers missing from subject-relevant sentences. */
function recall(views: unknown[], actual: unknown, kind: string): MetricEntry {
  const truths = new Map<string, Map<string, string[]>>();
  let total = 0;
  for (const raw of views) {
    const view = object(raw);
    const name = String(view.name || "");
    for (const a of list(view.artifacts).map(object)) {
      if (a.artifactType !== kind) continue;
      const subjects =
        kind === "OUTLIERS"
          ? new Map<string, string[]>()
          : truths.get(name) || new Map<string, string[]>();
      for (const it of artifactItems(a)) {
        const subject = String(kind === "OUTLIERS" ? it.dimensions : it.insight || "");
        if (kind !== "OUTLIERS" && subjects.has(subject)) continue;
        const values = extractNarrativeNumbers(
          clean(kind === "OUTLIERS" ? it.formattedValue : it.insight || ""),
        ).map(normalizeNarrativeNumber);
        if (kind === "OUTLIERS" && !("formattedValue" in it)) continue;
        subjects.set(subject, [...(subjects.get(subject) || []), ...values]);
        total += values.length;
      }
      truths.set(name, subjects);
    }
  }
  const original = summaryText(actual)
    .split(/\. |\n/)
    .filter((s) => s.trim());
  const normalized = original.map((s) => {
    let text = s;
    for (const n of extractNarrativeNumbers(s))
      text = text.split(n).join(normalizeNarrativeNumber(n));
    return text;
  });
  const missing: string[] = [];
  for (const [view, subjects] of truths) {
    for (const [subject, values] of subjects) {
      const remaining = new Set(values);
      for (const sentence of normalized) {
        if (!relevant(subject, sentence)) continue;
        const found = extractNarrativeNumbers(sentence).map(normalizeNarrativeNumber);
        for (const truth of values) {
          if (sentence.includes(truth) || found.some((n) => approximatelyEqual(truth, n))) {
            remaining.delete(truth);
          }
        }
      }
      // Compare the full value of scaled numbers as well: the reference
      // normalization intentionally preserves some written-number quirks.
      for (const sentence of original) {
        if (!relevant(subject, sentence)) continue;
        for (const n of extractNarrativeNumbers(sentence, true)) {
          for (const v of remaining) {
            if (approximatelyEqual(n, v)) remaining.delete(v);
          }
        }
      }
      for (const value of remaining) {
        missing.push(
          `*View: ${view}, *${kind === "OUTLIERS" ? "Dimensions" : "Insight"}: ${subject}, *Value: ${value}`,
        );
      }
    }
  }
  return entry(
    kind === "OUTLIERS" ? 2 : 3,
    total ? 1 - round4(missing.length / total) : 1,
    `Below are missing ground truths in the narrative for ${kind}:\n${missing.length ? missing.map((s, i) => `${i + 1}. ${s}\n`).join("") : "None"}`,
  );
}

/** Precision accepts figures backed by artifacts OR the reference summary. */
function precision(views: unknown[], expected: unknown, actual: unknown): MetricEntry {
  const truths = new Map<string, string[]>();
  const byNumber = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, n: string, s: string) =>
    map.set(n, [...(map.get(n) || []), s]);
  for (const view of views.map(object)) {
    for (const a of list(view.artifacts).map(object)) {
      const fields =
        a.artifactType === "OUTLIERS"
          ? ["formattedValue", "tooltip"]
          : a.artifactType === "PULSE_INSIGHTS"
            ? ["insight"]
            : [];
      for (const it of artifactItems(a)) {
        for (const key of fields) {
          if (!(key in it)) continue;
          for (const n of extractNarrativeNumbers(clean(it[key]))) {
            add(
              truths,
              normalizeNarrativeNumber(n),
              String(it[a.artifactType === "OUTLIERS" ? "dimensions" : "insight"]),
            );
          }
        }
      }
    }
  }
  const reference = typeof expected === "string" ? expected : object(expected).insightNarrative;
  if (typeof reference === "string")
    for (const s of reference.split(/\. |\n/))
      for (const n of extractNarrativeNumbers(s)) add(truths, normalizeNarrativeNumber(n), s);
  let total = 0;
  for (const s of summaryText(actual).split(/\. |\n/))
    for (const n of extractNarrativeNumbers(s)) {
      add(byNumber, normalizeNarrativeNumber(n), s);
      total++;
    }
  for (const [truth, subjects] of truths) {
    for (const subject of subjects) {
      for (const [n, sentences] of byNumber) {
        if (approximatelyEqual(truth, n)) {
          byNumber.set(
            n,
            sentences.filter((s) => !relevant(subject, s)),
          );
        }
      }
    }
  }
  let details = truths.size
    ? ""
    : "NOTE: all artifacts are empty or no numeric values are found.\n";
  details +=
    "Below are the numeric values in the narrative that are not based on the ground truths from the provided artifacts:\n";
  let wrong = 0;
  for (const [n, sentences] of byNumber)
    for (const s of sentences) details += `${++wrong}. *Numeric Value: ${n}, *Narrative: ${s}\n`;
  if (!wrong) details += "None";
  return entry(4, total ? round4(1 - wrong / total) : 1, details);
}

/** The five entries, in the evaluator's configuration order. */
export function computeNarrativeMetrics(
  views: unknown[],
  expected: unknown,
  actual: unknown,
): MetricEntry[] {
  return NARRATIVE_METRIC_GROUPS.flatMap((group) =>
    computeNarrativeMetricGroup(group, views, expected, actual),
  );
}

// These groups have no data dependencies. The async runner schedules them
// independently so a large summary can use more than one CPU core.
export const NARRATIVE_METRIC_GROUPS = ["prose", "outliers", "insights", "precision"] as const;
export type NarrativeMetricGroup = (typeof NARRATIVE_METRIC_GROUPS)[number];

export function computeNarrativeMetricGroup(
  group: NarrativeMetricGroup,
  views: unknown[],
  expected: unknown,
  actual: unknown,
): MetricEntry[] {
  // Repeated numbers often share subjects/sentences. Each synchronous group
  // owns the cache until it returns; clear it between worker tasks/cases.
  relevanceCache.clear();
  if (group === "outliers") return [recall(views, actual, "OUTLIERS")];
  if (group === "insights") return [recall(views, actual, "PULSE_INSIGHTS")];
  if (group === "precision") return [precision(views, expected, actual)];
  const sentences = summaryText(actual)
    .split(". ")
    .filter((s) => s.trim());
  const { sum, n } = offDiagonalSimilaritySum(sentences);
  return [readability(actual), entry(1, 1 - round4(n ? sum / (n * n) : 0), null)];
}
