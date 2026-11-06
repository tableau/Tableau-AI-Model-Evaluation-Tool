/**
 * Shared design primitives.
 *
 * The layout idioms (FlexCard, MetricsLayout, action colors) come from the
 * designed console (TestCaseEvaluation.tsx — the interface published
 * in the published paper), lifted here so the dashboard and results page speak
 * one dialect instead of re-inventing antd defaults. This file is the single
 * source for score colors and pills on both.
 */

import React from 'react';
import { TDS } from '../ui/tokens';
import { Card } from '../ui/basics';

/**
 * The one score palette (low / medium / high), used wherever a score is
 * shown: dashboard history, results summary, per-case pills, formula diffs.
 *
 * These are the Tableau Design System feedback colors — red, amber, GREEN.
 * The retired console used a blue "high" stop, and for a while the dashboard
 * and the results page each had their own idea of what a good score looked
 * like. Text shades are darkened to clear WCAG AA (4.5:1) on their tints.
 */
export const SCORE_COLORS = {
  low: { color: '#B3261E', background: '#FADCDA' },
  medium: { color: '#8A6116', background: '#FCF0CE' },
  high: { color: '#216E4E', background: '#DFF2E9' },
} as const;

/** Primary CTA / destructive action colors (Evaluate / Stop buttons). */
// Action colors follow the Tableau Design System tokens (src/tdsTheme.ts).
export const PRIMARY_COLOR = TDS.primary;
export const DANGER_COLOR = TDS.danger;

const PILL_BASE: React.CSSProperties = {
  borderRadius: 4,
  padding: '2px 8px',
  fontWeight: 600,
  display: 'inline-block',
};

/** Score pill style keyed by percentage. Thresholds are 33 / 66 everywhere
 *  except in a category with its own baseline (ScorePill's `tone`). */
export const badgeStyle = (pct: number): React.CSSProperties => {
  const stop = pct < 33 ? SCORE_COLORS.low : pct < 66 ? SCORE_COLORS.medium : SCORE_COLORS.high;
  return { ...PILL_BASE, color: stop.color, backgroundColor: stop.background };
};

/** Neutral pill for "no score" / "Unavailable" states. "Unavailable" is a
 *  judge failure the operator is meant to notice, so it has to be legible
 *  rather than greyed into the background (#8a929c measured 2.81:1). */
export const SCORE_NA = {
  color: '#666E79',
  background: 'rgba(138, 146, 156, 0.12)',
} as const;

export const NA_PILL_STYLE: React.CSSProperties = {
  ...PILL_BASE,
  color: SCORE_NA.color,
  backgroundColor: SCORE_NA.background,
};

/**
 * A 0-1 score as a colored percentage pill. `unavailable` marks a judge
 * metric that exists but could not be scored (the judge errored), which is
 * different from "—" (the metric does not apply).
 */
export const ScorePill: React.FC<{
  val: number | null | undefined;
  unavailable?: boolean;
  decimals?: number;
  /** The colour of a band against a baseline (baseline.tsx `baselineTone`),
   *  in place of the 33 / 66 bands. */
  tone?: { color: string; background: string };
}> = ({ val, unavailable, decimals = 0, tone }) => {
  // The class names carry no look of their own: a breakdown table uses them
  // to give its pills one width so the numbers line up in a column.
  if (val === null || val === undefined) {
    return <span className="score-pill score-pill-na" style={NA_PILL_STYLE}>{unavailable ? 'Unavailable' : '\u2014'}</span>;
  }
  const style = tone ? { ...PILL_BASE, color: tone.color, backgroundColor: tone.background } : badgeStyle(val * 100);
  return <span className="score-pill" style={style}>{`${(val * 100).toFixed(decimals)}%`}</span>;
};

/**
 * Flex row of metric/summary cards — the console's MetricsLayout idiom
 * (gap 24, wrapping by default, single scroll row with scrollCards).
 */
export const MetricsLayout: React.FC<{
  children: React.ReactNode;
  scrollCards?: boolean;
}> = ({ children, scrollCards }) => (
  <div
    style={{
      display: 'flex',
      gap: 24,
      ...(scrollCards
        ? { overflowX: 'auto', flexWrap: 'nowrap' }
        : { flexWrap: 'wrap' }),
    }}
  >
    {children}
  </div>
);

/** A single summary card in a MetricsLayout row — the console's FlexCard. */
export const FlexCard: React.FC<{
  title: React.ReactNode;
  /** Right-aligned in the header, e.g. a status tag. */
  extra?: React.ReactNode;
  loading?: boolean;
  /** Fill the cell of a grid (same width and height as its neighbours)
   *  instead of sizing to the content. */
  fill?: boolean;
  children: React.ReactNode;
}> = ({ title, extra, loading, fill, children }) =>
  fill ? (
    <Card title={title} extra={extra} loading={loading} className="flex-card-fill" bodyStyle={{ padding: 16 }}>
      {children}
    </Card>
  ) : (
    <div style={{ flex: '0 0 max-content' }}>
      <Card
        title={title}
        extra={extra}
        loading={loading}
        style={{ minWidth: 'max-content' }}
        bodyStyle={{ overflowX: 'auto', padding: 16 }}
      >
        {children}
      </Card>
    </div>
  );

/** Headline number style used inside FlexCard Statistics. */
export const STAT_VALUE_STYLE: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
};
