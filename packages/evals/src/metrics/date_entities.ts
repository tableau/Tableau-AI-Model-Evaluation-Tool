/**
 * Lightweight date/time entity span detector — the injectable substitute for
 * spaCy `en_core_web_trf` NER, used ONLY for the `is_date_related` check in the
 * DashboardNarrativeNumerical* metrics.
 *
 * Reference comparison principle:
 *   - The reference metric loads a RoBERTa NER model purely to answer
 *     "is this number inside a DATE/TIME span?". Pulling transformers.js /
 *     onnxruntime here would make this assembly layer heavy and non-trivial to
 *     compile. Per the plan we keep it DEPENDENCY-LIGHT and INJECTABLE.
 *   - This default detector is a rules/regex date/time-span finder. It is
 *     explicitly a KNOWN, TOLERANCE-RELAXED DIVERGENCE from spaCy: label set,
 *     tokenization and span boundaries will differ. Callers that need spaCy
 *     parity can inject a transformers.js-backed detector at the seam.
 *
 * A detector maps text -> list of DATE/TIME spans with char offsets, matching
 * how the reference consumes `ent.start_char` / `ent.end_char`.
 */

export interface DateTimeSpan {
  text: string;
  label: "DATE" | "TIME";
  startChar: number;
  endChar: number;
}

export type DateEntityDetector = (text: string) => DateTimeSpan[];

// Month names (full + common abbreviations).
const MONTHS =
  "(?:january|february|march|april|may|june|july|august|september|october|november|december|" +
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";

// Days of the week.
const WEEKDAYS = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";

// Relative date phrases like "the last three months", "next quarter".
const RELATIVE =
  "(?:the\\s+)?(?:last|next|past|previous|coming|this)\\s+" +
  "(?:\\d+\\s+|one\\s+|two\\s+|three\\s+|four\\s+|five\\s+|six\\s+|seven\\s+|" +
  "eight\\s+|nine\\s+|ten\\s+)?" +
  "(?:year|years|month|months|quarter|quarters|week|weeks|day|days)";

/**
 * The DATE/TIME patterns. Order matters — earlier (more specific / longer)
 * patterns are matched first so we prefer e.g. "5pm on Tuesday" over "5pm".
 * Each entry carries its label. Overlapping matches are resolved by keeping the
 * first (longest-first) and discarding spans that overlap an already-kept span.
 */
const PATTERNS: { re: RegExp; label: "DATE" | "TIME" }[] = [
  // TIME: clock time optionally followed by "on <weekday>", e.g. "5pm on Tuesday".
  { re: new RegExp(`\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\s+on\\s+${WEEKDAYS}\\b`, "gi"), label: "TIME" },
  // TIME: "5pm", "10:30am", "14:00".
  { re: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, label: "TIME" },
  { re: /\b\d{1,2}:\d{2}\b/g, label: "TIME" },
  // DATE: "January 2024", "Jan 2024".
  { re: new RegExp(`\\b${MONTHS}\\.?\\s+\\d{4}\\b`, "gi"), label: "DATE" },
  // DATE: "January 5, 2024", "Jan 5 2024".
  { re: new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2}(?:,)?\\s+\\d{4}\\b`, "gi"), label: "DATE" },
  // DATE: "Q3 2023", "Q1 2024".
  { re: /\bQ[1-4]\s+\d{4}\b/gi, label: "DATE" },
  // DATE: numeric dates "2024-01-05", "01/05/2024".
  { re: /\b\d{4}-\d{1,2}-\d{1,2}\b/g, label: "DATE" },
  { re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, label: "DATE" },
  // DATE: relative date phrases.
  { re: new RegExp(`\\b${RELATIVE}\\b`, "gi"), label: "DATE" },
  // DATE: bare 4-digit year on its own (kept last so it doesn't split richer spans).
  { re: /\b(?:19|20)\d{2}\b/g, label: "DATE" },
  // DATE: standalone month/weekday name.
  { re: new RegExp(`\\b${MONTHS}\\b`, "gi"), label: "DATE" },
  { re: new RegExp(`\\b${WEEKDAYS}\\b`, "gi"), label: "DATE" },
];

/**
 * Default rules/regex DATE/TIME span detector. Returns non-overlapping spans,
 * preferring longer/more-specific matches. This is intentionally a heuristic —
 * see the module-level divergence note.
 */
export const detectDateTimeSpans: DateEntityDetector = (text: string): DateTimeSpan[] => {
  if (!text) return [];
  const candidates: DateTimeSpan[] = [];
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      candidates.push({
        text: m[0],
        label,
        startChar: m.index,
        endChar: m.index + m[0].length,
      });
      // Guard against zero-length matches looping forever.
      if (m.index === re.lastIndex) re.lastIndex++;
      m = re.exec(text);
    }
  }
  // Sort by start, then longest span first (prefer richer matches).
  candidates.sort((a, b) => {
    if (a.startChar !== b.startChar) return a.startChar - b.startChar;
    return b.endChar - b.startChar - (a.endChar - a.startChar);
  });
  // Keep non-overlapping spans (greedy by earliest start, longest first).
  const kept: DateTimeSpan[] = [];
  for (const c of candidates) {
    const overlaps = kept.some((k) => c.startChar < k.endChar && c.endChar > k.startChar);
    if (!overlaps) kept.push(c);
  }
  kept.sort((a, b) => a.startChar - b.startChar);
  return kept;
};

/**
 * Is [numberStart, numberEnd] fully inside
 * any detected DATE/TIME span?
 */
export function isDateRelated(
  spans: DateTimeSpan[],
  numberStart: number,
  numberEnd: number,
): boolean {
  for (const s of spans) {
    if (s.startChar <= numberStart && numberEnd <= s.endChar) return true;
  }
  return false;
}
