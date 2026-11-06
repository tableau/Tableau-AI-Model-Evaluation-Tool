/**
 * Deterministic scoring of a generated color palette.
 * Golden fixtures pin deterministic metrics and explanations.
 *
 * Four checks, each a score from 0 to 1, computed from the colors alone (no
 * model call):
 *
 * - `distinguishability` (regular palettes): can every pair of colors be told
 *   apart?
 * - `gradientSmoothness` (sequential and diverging palettes): are the steps
 *   from one color to the next even?
 * - `divergingStructure` (diverging palettes): two clearly different ends and
 *   a middle that differs from both?
 * - `groundTruthValidity` (cases that define expected colors): how close are
 *   the generated colors to the expected ones?
 *
 * All four measure color difference as CIEDE2000 Delta E between colors
 * converted from sRGB hex to CIE L*a*b* (D65), via `lib/ciede2000.ts`. The
 * formulas, thresholds, explanations and metric ids are pinned by
 * `goldens/color-palette/palette_metric_parity.json` (103
 * palettes scored by the reference implementation) pins it; see
 * `palette_metrics.test.ts`.
 *
 * Unlike `classes.ts`'s `compute*Palette*` functions (the evaluator-metric
 * registry path, which emits `Metric:<name>` ids and no explanations), this
 * module produces the exact row entries the tool's own palette adapter
 * (`adapters/palettes.ts`) writes: stable metric ids + explanations + the
 * errors for checks that could not run.
 */

import type { MetricEntry, RowError } from "@tableau-ai-eval/core";
import { deltaECIE2000, hexToLab } from "./lib/ciede2000.ts";

export const STAGE = "colorPalette";

// Metric ids as they appear in results recorded so far (and in datasources
// already published): kept so old and new rows of one metric share an id.
export const DISTINGUISHABILITY_ID = "9c7b11e7a275b3d49d678b11ac36efe2";
export const GRADIENT_SMOOTHNESS_ID = "d6f9251b307c32efd2521aa43e312923";
export const DIVERGING_STRUCTURE_ID = "117d7057ae12c7a4f6a556979d688a5f";
export const GROUND_TRUTH_ID = "1a787b1f67b72734cf27c1bfcad12050";

/** Delta E below which two colors of a regular palette are too alike. */
const MIN_DISTANCE_THRESHOLD = 10.0;
/** Delta E the two ends of a diverging palette must be apart, and the middle from each end. */
const ENDPOINT_DISTANCE_THRESHOLD = 30.0;
const MIDPOINT_DISTANCE_THRESHOLD = 10.0;
/**
 * Ground Truth Match: an expected color and the generated color it is paired
 * with count as the same color up to this Delta E (a difference seen only side
 * by side), score one half at the next, and fall off smoothly beyond. The
 * expectations name color families ("red, blue, yellow"), not exact sRGB
 * values: a flag's red (#B22234) is 19 from pure red and a correct answer.
 * Tool-specific scale; older reference scoring halved the score at
 * an average distance of 10, which scored such answers 0.4.
 */
const GROUND_TRUTH_SAME_COLOR_DISTANCE = 5.0;
const GROUND_TRUTH_HALF_SCORE_DISTANCE = 25.0;

type Lab = [number, number, number];
type ValidLab = [number, unknown, Lab];

/** Python's `str(float)` for the integral thresholds above ("10.0"). */
const pyNum = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
/** Python's `f"{x:.Nf}"`. */
const fx = (x: number, n: number): string => x.toFixed(n);
/** Python's `str(value)` for a color as given (string or not). */
const pyStr = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
};

/**
 * A hex color ("#FF0000" or "FF0000") in CIE L*a*b*. Throws for anything that
 * is not six hex digits (, which `lstrip("#")`s).
 */
export function paletteHexToLab(hexColor: unknown): Lab {
  if (typeof hexColor !== "string") throw new TypeError("color is not a string");
  const digits = hexColor.replace(/^#+/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) throw new Error(`Invalid hex color: ${digits}`);
  return hexToLab(digits);
}

/** (position, color as given, L*a*b*) for every color that reads as hex. */
function validLabs(colors: unknown[]): ValidLab[] {
  const out: ValidLab[] = [];
  colors.forEach((color, i) => {
    try {
      out.push([i, color, paletteHexToLab(color)]);
    } catch {
      /* left out */
    }
  });
  return out;
}

function entry(metricId: string, name: string, score: number, explanation: string): MetricEntry {
  return { metric_id: metricId, metric_name: name, score, explanation };
}

function noColorsError(metric: string): RowError {
  return {
    phase: "EVALUATE_RESULT",
    description: `No colors found in actual result for ${metric} evaluation`,
    warning: false,
  };
}

const clamp = (x: number): number => Math.max(0.0, Math.min(1.0, x));
const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;

// ---------------------------------------------------------------------------
// The four checks
// ---------------------------------------------------------------------------

function distinguishability(colors: unknown[]): MetricEntry {
  const labs = validLabs(colors);
  const distances: [number, number, number][] = [];
  for (let a = 0; a < labs.length; a++) {
    for (let b = a + 1; b < labs.length; b++) {
      distances.push([labs[a]![0], labs[b]![0], deltaECIE2000(labs[a]![2], labs[b]![2])]);
    }
  }
  const threshold = MIN_DISTANCE_THRESHOLD;
  const t = pyNum(threshold);
  let score: number;
  let explanation: string;
  if (!distances.length) {
    score = 0.0;
    explanation = "Could not calculate color distances (invalid colors or insufficient colors)";
  } else {
    const minDistance = Math.min(...distances.map((d) => d[2]));
    if (minDistance >= threshold) {
      score = 1.0;
      explanation =
        "All color pairs are sufficiently distinguishable. " +
        `Minimum distance: ${fx(minDistance, 2)} (threshold: ${t})`;
    } else {
      const tooClose = distances
        .filter(([, , d]) => d < threshold)
        .map(
          ([i, j, d]) =>
            `Colors ${i} (${pyStr(colors[i])}) and ${j} (${pyStr(colors[j])}) ` +
            `have distance ${fx(d, 2)} (threshold: ${t})`,
        );
      score = clamp(minDistance / threshold);
      explanation =
        "Some color pairs are not sufficiently distinguishable. " +
        `Minimum distance: ${fx(minDistance, 2)} (threshold: ${t}). ` +
        `Pairs below threshold:\n${tooClose.join("\n")}`;
    }
  }
  return entry(DISTINGUISHABILITY_ID, "distinguishability", score, explanation);
}

function gradientSmoothness(colors: unknown[]): MetricEntry {
  const labs = validLabs(colors).map((v) => v[2]);
  const steps: number[] = [];
  for (let i = 0; i + 1 < labs.length; i++) steps.push(deltaECIE2000(labs[i]!, labs[i + 1]!));
  let score: number;
  let explanation: string;
  if (!steps.length) {
    score = 0.0;
    explanation =
      "Could not calculate sequential color distances (invalid colors or insufficient colors)";
  } else if (steps.length === 1) {
    score = 1.0;
    explanation = `Single step distance: ${fx(steps[0]!, 2)}`;
  } else {
    const meanStep = mean(steps);
    if (meanStep === 0) {
      score = 0.0;
      explanation = "All colors are identical (no gradient)";
    } else {
      // Even steps have a low spread relative to their mean; the score falls
      // from 1 (identical steps) towards 0 as the spread grows.
      const stdDev = Math.sqrt(steps.reduce((s, v) => s + (v - meanStep) ** 2, 0) / steps.length);
      const variation = stdDev / meanStep;
      score = clamp(1.0 / (1.0 + variation));
      explanation =
        `Gradient smoothness calculated from ${steps.length} steps. ` +
        `Mean step distance: ${fx(meanStep, 2)}, ` +
        `Std deviation: ${fx(stdDev, 2)}, ` +
        `Coefficient of variation: ${fx(variation, 3)}. ` +
        `Step distances: [${steps.map((s) => `'${fx(s, 2)}'`).join(", ")}]`;
    }
  }
  return entry(GRADIENT_SMOOTHNESS_ID, "gradientSmoothness", score, explanation);
}

function divergingStructure(colors: unknown[]): MetricEntry {
  const labs = validLabs(colors);
  if (labs.length < 3) {
    return entry(
      DIVERGING_STRUCTURE_ID,
      "divergingStructure",
      0.0,
      "Not enough valid colors for diverging palette structure evaluation " +
        `(need at least 3, found ${labs.length})`,
    );
  }
  const [, firstColor, firstLab] = labs[0]!;
  const [, lastColor, lastLab] = labs[labs.length - 1]!;
  const [, midColor, midLab] = labs[Math.floor(labs.length / 2)]!;
  const endT = ENDPOINT_DISTANCE_THRESHOLD;
  const midT = MIDPOINT_DISTANCE_THRESHOLD;

  const ends = deltaECIE2000(firstLab, lastLab);
  const midFirst = deltaECIE2000(midLab, firstLab);
  const midLast = deltaECIE2000(midLab, lastLab);
  // All three must hold for a full score, so the weakest one decides.
  const score = Math.min(clamp(ends / endT), clamp(midFirst / midT), clamp(midLast / midT));

  const issues: string[] = [];
  if (ends < endT) {
    issues.push(
      `Endpoints (${pyStr(firstColor)} and ${pyStr(lastColor)}) ` +
        `are too similar (distance: ${fx(ends, 2)}, threshold: ${pyNum(endT)})`,
    );
  }
  if (midFirst < midT) {
    issues.push(
      `Midpoint (${pyStr(midColor)}) is too similar to first endpoint ` +
        `(distance: ${fx(midFirst, 2)}, threshold: ${pyNum(midT)})`,
    );
  }
  if (midLast < midT) {
    issues.push(
      `Midpoint (${pyStr(midColor)}) is too similar to last endpoint ` +
        `(distance: ${fx(midLast, 2)}, threshold: ${pyNum(midT)})`,
    );
  }
  const explanation = issues.length
    ? "Diverging palette structure issues found:\n" +
      issues.map((i) => `- ${i}`).join("\n") +
      `\n\nDistances: endpoints=${fx(ends, 2)}, ` +
      `midpoint-to-first=${fx(midFirst, 2)}, ` +
      `midpoint-to-last=${fx(midLast, 2)}`
    : "Diverging palette has proper structure. " +
      `Endpoints are distinct (distance: ${fx(ends, 2)}), ` +
      "and midpoint is distinct from both endpoints " +
      `(distances: ${fx(midFirst, 2)}, ${fx(midLast, 2)})`;
  return entry(DIVERGING_STRUCTURE_ID, "divergingStructure", score, explanation);
}

function closestUnmatched(lab: Lab, actual: ValidLab[], used: Set<number>): [number, number] | null {
  let best: [number, number] | null = null;
  for (const [idx, , actualLab] of actual) {
    if (used.has(idx)) continue;
    const distance = deltaECIE2000(lab, actualLab);
    if (best === null || distance < best[0]) best = [distance, idx];
  }
  return best;
}

/**
 * The Delta E of each expected color to the generated color it is paired
 * with. Sequential and diverging palettes pair by position (order is the point
 * of them): the first expected color with the first generated one, the last
 * with the last, and the ones between at the same relative position, so a
 * 3-color expectation lines up with a 7-step answer. A position that is used
 * or unreadable falls back to the closest color still unpaired. Regular
 * palettes pair each expected color with the closest unpaired one.
 */
function matchDistances(
  expected: ValidLab[],
  actual: ValidLab[],
  ordered: boolean,
  nExpected: number,
  nActual: number,
): number[] {
  const distances: number[] = [];
  const used = new Set<number>();
  const byPosition = new Map(actual.map((a) => [a[0], a]));
  for (const [expIdx, , expLab] of expected) {
    if (ordered && nExpected > 0 && nActual > 0) {
      const target = nExpected > 1 ? pyRound((expIdx * (nActual - 1)) / (nExpected - 1)) : 0;
      const paired = byPosition.get(target);
      if (paired !== undefined && !used.has(paired[0])) {
        distances.push(deltaECIE2000(expLab, paired[2]));
        used.add(paired[0]);
        continue;
      }
    }
    const best = closestUnmatched(expLab, actual, used);
    if (best !== null) {
      distances.push(best[0]);
      used.add(best[1]);
    }
  }
  return distances;
}

/** 1.0 up to the same-color distance, one half at the half-score distance, approaching 0 beyond. */
export function colorMatchScore(distance: number): number {
  const same = GROUND_TRUTH_SAME_COLOR_DISTANCE;
  const half = GROUND_TRUTH_HALF_SCORE_DISTANCE;
  if (distance <= same) return 1.0;
  return clamp(1.0 / (1.0 + (distance - same) / (half - same)));
}

/** Python's `round()` on a float: half to even. */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function groundTruth(
  paletteType: string | null | undefined,
  expectedColors: unknown[],
  colors: unknown[],
): [MetricEntry[], RowError[]] {
  const expected = validLabs(expectedColors);
  const actual = validLabs(colors);
  const distances =
    expected.length && actual.length
      ? matchDistances(
          expected,
          actual,
          paletteType === "sequential" || paletteType === "diverging",
          expectedColors.length,
          colors.length,
        )
      : [];
  if (!distances.length) {
    return [
      [],
      [
        {
          phase: "EVALUATE_RESULT",
          description: "Could not match colors (invalid colors or no valid matches)",
          warning: false,
        },
      ],
    ];
  }
  // Each expected color scores on its own distance; the mean is then scaled
  // by the share of expected colors that found a partner, so a missing color
  // costs its share rather than nothing.
  const matched = distances.length;
  const nExpected = expectedColors.length;
  const score = clamp((mean(distances.map(colorMatchScore)) * matched) / nExpected);
  const same = GROUND_TRUTH_SAME_COLOR_DISTANCE;
  const half = GROUND_TRUTH_HALF_SCORE_DISTANCE;
  let explanation =
    `Matched ${matched} of ${nExpected} expected colors. ` +
    `Average Delta E ${fx(mean(distances), 1)} (largest ${fx(Math.max(...distances), 1)}): ` +
    `a distance up to ${same} counts as the same color, ${half} scores one half.`;
  if (matched < nExpected) {
    explanation += ` ${nExpected - matched} expected color(s) found no match.`;
  }
  if (colors.length > nExpected) {
    explanation +=
      ` The palette has ${colors.length} colors where ${nExpected} were expected;` +
      " the extra colors are not scored.";
  } else if (colors.length < nExpected) {
    explanation += ` The palette has ${colors.length} colors where ${nExpected} were expected.`;
  }
  return [[entry(GROUND_TRUTH_ID, "groundTruthValidity", score, explanation)], []];
}

/**
 * Score one generated palette: (metric entries for the `colorPalette` stage,
 * errors for checks that could not run). Which checks apply follows the
 * palette type the case asked for; the ground-truth check runs only when the
 * case defines expected colors.
 */
export function computePaletteMetrics(
  paletteType: string | null | undefined,
  expectedColors: unknown,
  colors: unknown,
): [MetricEntry[], RowError[]] {
  const entries: MetricEntry[] = [];
  const errors: RowError[] = [];
  const list = Array.isArray(colors) && colors.length > 0 ? (colors as unknown[]) : null;

  if (paletteType === "regular") {
    if (list) entries.push(distinguishability(list));
    else errors.push(noColorsError("color palette distinguishability"));
  }
  if (paletteType === "sequential" || paletteType === "diverging") {
    if (list) entries.push(gradientSmoothness(list));
    else errors.push(noColorsError("gradient smoothness"));
  }
  if (paletteType === "diverging") {
    if (list) entries.push(divergingStructure(list));
    else errors.push(noColorsError("diverging palette structure"));
  }
  if (Array.isArray(expectedColors) && expectedColors.length) {
    if (list) {
      const [e, errs] = groundTruth(paletteType, expectedColors, list);
      entries.push(...e);
      errors.push(...errs);
    } else {
      errors.push(noColorsError("ground truth color palette"));
    }
  }
  return [entries, errors];
}
