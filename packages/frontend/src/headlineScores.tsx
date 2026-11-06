/**
 * A run's headline scores: the capability's own averages (Calculated
 * Fields, Visualization Quality, Intent & Spec, Natural Language Quality…)
 * listed one per line, never blended into a single number. The backend
 * picks them (`metric_catalog.headline_scores`), so every surface lists
 * the same set in the same order.
 *
 * Colour is the comparison with the baseline (decision of 2026-09-30): green
 * at or above it, yellow up to 25 points below, red further below — the
 * bands of `baseline.tsx`. The difference itself is not printed in the
 * tables; hovering a score names its baseline. A score with no baseline
 * to read against is grey.
 */

import React from 'react';
import { Tooltip, Typography } from './ui';
import { SparklesIcon } from './ui/icons';
import { SCORE_COLORS, SCORE_NA } from './components/designSystem';
import { deltaBand } from './baseline';
import type { HeadlineScore } from './evaluationGroups';

const { Text } = Typography;

/** The baseline a score is read against, if its suite has one. */
export type BaselineLookup = (
  suiteId: string | null | undefined,
) => { baseline: number; provisional: boolean } | null;

const BAND_TONE = { higher: 'high', 'little-lower': 'medium', 'much-lower': 'low' } as const;

/** What a score the judge took part in says on hover, so a judge-on run is
 *  not read against a judge-off run of the same suite. */
export function judgeNote(h: HeadlineScore): string | null {
  if (!h.judge_scores) return null;
  const of = h.total_scores ? ` of the ${h.total_scores} metrics averaged` : ' metrics';
  return `The evaluator model scored ${h.judge_scores}${of}. Compare with runs that also used an evaluator model.`;
}

/** A score the judge made alone (Natural Language Quality): it carries the
 *  sparkle. A score that mixes the judge's ratings with deterministic
 *  checks (Palette Quality) does not; its tooltip still says how many of
 *  its metrics the judge scored. */
export function judgeOnly(h: HeadlineScore): boolean {
  return Boolean(h.judge_scores) && h.judge_scores === h.total_scores;
}

/** The purple sparkle before a score the judge made alone. */
export const JudgeSpark: React.FC<{ scores: HeadlineScore[] | undefined | null }> = ({ scores }) => {
  const judged = (scores || []).filter((h) => h.average != null && judgeOnly(h));
  if (!judged.length) return null;
  return (
    <Tooltip title={judgeNote(judged[0])}>
      <SparklesIcon
        role="img"
        aria-label="Includes evaluator model scores"
        style={{ marginRight: 2, color: '#8B5CF6', cursor: 'help', fontSize: 13, verticalAlign: '-2px' }}
      />
    </Tooltip>
  );
};

/** "Visualization Quality 55.7% (Intent and Spec 56.0%, for reference) ·
 *  Natural Language Quality 63.9%" for plain-text places. */
export function headlineText(scores: HeadlineScore[] | undefined | null): string {
  const pct = (h: HeadlineScore) => `${((h.average as number) * 100).toFixed(1)}%`;
  return (scores || [])
    .filter((h) => h.average != null)
    .map((h) => {
      const context = (h.context || []).filter((c) => c.average != null);
      const ref = context.length
        ? ` (${context.map((c) => `${c.label} ${pct(c)}`).join(', ')}, for reference)`
        : '';
      return `${h.label} ${pct(h)}${ref}`;
    })
    .join(' · ');
}

/** What a reference score is, on hover. */
export const CONTEXT_NOTE = 'Shown for reference: not part of the average above it.';

/** The colour of the judge's sparkle (NlqResultsPage `JudgeMark`). */
export const JUDGE_COLOR = '#8B5CF6';

/** The three bands, for a legend beside a table of scores, and what the
 *  purple sparkle on a metric means. `bands`: "baseline" where a pill is
 *  coloured against the suite's baseline (the home page, the capability
 *  cards), "fixed" where it keeps the 33 / 66 bands (a results table and its
 *  cards, except the Prep categories with their own baseline). */
export const BaselineLegend: React.FC<{
  bands?: 'baseline' | 'fixed';
  /** One suite's baseline (0-1): the legend then prints that suite's own
   *  ranges, "85% to 100%", "60% to 84%", "Below 60%". */
  baseline?: number | null;
}> = ({ bands = 'baseline', baseline }) => {
  const b = baseline == null ? null : Math.round(baseline * 100);
  const names = b != null
    ? [`${b}% to 100%`, `${b - 25}% to ${b - 1}%`, `Below ${b - 25}%`]
    : bands === 'fixed'
    ? ['66% and above', '33% to 66%', 'Below 33%']
    : ['At or above baseline', 'Up to 25 points below', 'More than 25 points below'];
  return (
    <span className="baseline-legend">
      {b != null && <span className="baseline-legend-baseline">Baseline {b}%</span>}
      <span>Score colors</span>
      <span><i style={{ background: SCORE_COLORS.high.background, borderColor: SCORE_COLORS.high.color }} />{names[0]}</span>
      <span><i style={{ background: SCORE_COLORS.medium.background, borderColor: SCORE_COLORS.medium.color }} />{names[1]}</span>
      <span><i style={{ background: SCORE_COLORS.low.background, borderColor: SCORE_COLORS.low.color }} />{names[2]}</span>
      <span className="baseline-legend-judge">
        <SparklesIcon role="img" aria-label="Purple sparkle" style={{ color: JUDGE_COLOR, fontSize: 14 }} />
        Scored by the evaluator model
      </span>
    </span>
  );
};

export const HeadlineScores: React.FC<{
  scores: HeadlineScore[] | undefined | null;
  /** The suite these scores belong to, for scores that do not carry their own. */
  suiteId?: string | null;
  /** Looks up a suite's baseline; without it the pills are grey. */
  baselineOf?: BaselineLookup;
  /** Side by side (a header line) instead of one per line (a table cell). */
  inline?: boolean;
  /** Shown when there is nothing to list. */
  empty?: React.ReactNode;
}> = ({ scores, suiteId, baselineOf, inline, empty }) => {
  const list = (scores || []).filter((h) => h.average != null);
  if (!list.length) return <>{empty ?? <Text type="secondary">—</Text>}</>;
  return (
    <span className={inline ? 'headline-scores headline-scores-inline' : 'headline-scores'}>
      {list.map((h, i) => {
        const avg = h.average as number;
        const base = baselineOf ? baselineOf(h.suite_id ?? suiteId) : null;
        const band = base ? deltaBand(avg - base.baseline) : null;
        const tone = band ? SCORE_COLORS[BAND_TONE[band.key]] : SCORE_NA;
        // Only the baseline and the band (decision of 2026-10-23): no "provisional",
        // no point ranges, and the evaluator-model note stays on the sparkle.
        const tip = base && band
          ? `Baseline ${(base.baseline * 100).toFixed(1)}%: ${band.label}`
          : 'No baseline to compare with';
        return (
          <span key={h.key} className="headline-score">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {judgeOnly(h) && (
                <SparklesIcon
                  role="img"
                  aria-label="Includes evaluator model scores"
                  style={{ marginRight: 2, color: '#8B5CF6', fontSize: 13, verticalAlign: '-2px' }}
                />
              )}
              {h.label}
            </Text>
            <Tooltip title={tip}>
              <span className="headline-pill" style={{ color: tone.color, backgroundColor: tone.background }}>
                {`${(avg * 100).toFixed(1)}%`}
              </span>
            </Tooltip>
            {(h.context || [])
              .filter((c) => c.average != null)
              .map((c) => (
                <span key={c.key} className="headline-score headline-score-context">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {c.label}
                  </Text>
                  <Tooltip title={CONTEXT_NOTE}>
                    <span className="headline-pill headline-pill-context">
                      {`${((c.average as number) * 100).toFixed(1)}%`}
                    </span>
                  </Tooltip>
                </span>
              ))}
          </span>
        );
      })}
    </span>
  );
};
