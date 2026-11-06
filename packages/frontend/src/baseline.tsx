/**
 * Reading a score against its baseline (UX-10, Ewald: "scores mean nothing
 * without a baseline"). The baseline is the overall score Tableau's default
 * model reached on the same suite on the reference build (measured for most
 * capabilities on 2026-10-11 to 13; visualization and dashboard Q&A are
 * still provisional), and every surface that shows a difference says so
 * when it is.
 *
 * Bands (decision of 2026-09-30): Higher (at or above the baseline), Little
 * lower (up to 25 points below), Much lower (further below). No other cutoffs.
 *
 * The band is shown ONLY as the colour of the score's pill, with the
 * baseline and the band named in its tooltip. No surface prints the signed
 * difference ("+3.3%") beside a score (decision of 2026-09-30, restated
 * 2026-10-19): a number beside the pill reads as a second score.
 */

import { SCORE_COLORS } from './components/designSystem';

export interface DeltaBand {
  key: 'higher' | 'little-lower' | 'much-lower';
  label: string;
  /** Text colour and tint, from the shared score palette. */
  color: string;
  background: string;
  explanation: string;
}

/** The band a difference (score minus baseline, 0-1) falls in. */
export function deltaBand(delta: number): DeltaBand {
  // Rounded so float noise cannot move a score across a band: 0.70 against
  // 0.95 is exactly 25 points below, and that is still Little lower.
  const d = Math.round(delta * 1e9) / 1e9;
  if (d >= 0) {
    return {
      key: 'higher',
      label: 'Higher',
      color: SCORE_COLORS.high.color,
      background: SCORE_COLORS.high.background,
      explanation: 'Meets or beats the default model here.',
    };
  }
  if (d >= -0.25) {
    return {
      key: 'little-lower',
      label: 'Little lower',
      color: SCORE_COLORS.medium.color,
      background: SCORE_COLORS.medium.background,
      explanation: 'Check the breakdown of the capability that dropped. A gap smaller than the spread between repeat runs is noise.',
    };
  }
  return {
    key: 'much-lower',
    label: 'Much lower',
    color: SCORE_COLORS.low.color,
    background: SCORE_COLORS.low.background,
    explanation: 'Check the error count first. With few errors, the model is not a fit for this capability yet.',
  };
}

/**
 * The colour of a pill in a score category with its own baseline for the
 * run's capability (the catalog's `category_baselines_by_capability`: the
 * three Prep suites, agreed with the Tableau Prep team on 2026-10-22). The
 * bands above, so at 0.80 a pill is green from 80, yellow from 55 up to
 * 80 and red below 55. Undefined without a score or a baseline: the pill
 * keeps the 33 / 66 bands.
 */
export function baselineTone(
  val: number | null | undefined,
  baseline: number | null | undefined,
): DeltaBand | undefined {
  if (val == null || baseline == null) return undefined;
  return deltaBand(val - baseline);
}
