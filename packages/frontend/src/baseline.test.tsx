/**
 * A score is read against its baseline by colour only (decision of 2026-09-30,
 * restated 2026-10-19): the pill takes the band's colour and its tooltip
 * names the baseline. No surface prints the signed difference ("+3.3%")
 * beside a score; one place still did until 2026-10-19.
 */

import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { render, screen } from './testing.cjs';
import { HeadlineScores } from './headlineScores';
import { SCORE_COLORS, ScorePill } from './components/designSystem';
import { baselineTone } from './baseline';
import { METRIC_BUCKETS, categoryBaseline, relabelBuckets } from './nlqMetricBuckets';

const SIGNED_PERCENT = /[+−-]\d+(\.\d+)?%/;

test('a score above its baseline is a coloured pill with no difference beside it', () => {
  const { container } = render(
    <HeadlineScores
      inline
      scores={[{ key: 'dashboardQA', label: 'Answer quality', average: 0.833, suite_id: 's' }] as any}
      baselineOf={() => ({ baseline: 0.8, provisional: false })}
    />,
  );
  expect(container.textContent).toContain('83.3%');
  expect(container.textContent).not.toMatch(SIGNED_PERCENT);
  const pill = screen.getByText('83.3%');
  // The band's colour, not the grey of a score without a baseline.
  const probe = document.createElement('span');
  probe.style.color = SCORE_COLORS.high.color;
  expect(pill.style.color).toBe(probe.style.color);
});

test('a score below its baseline prints no difference either', () => {
  const { container } = render(
    <HeadlineScores
      inline
      scores={[{ key: 'dashboardQA', label: 'Answer quality', average: 0.5, suite_id: 's' }] as any}
      baselineOf={() => ({ baseline: 0.92, provisional: false })}
    />,
  );
  expect(container.textContent).not.toMatch(SIGNED_PERCENT);
  expect(SCORE_COLORS.low).toBeTruthy();
});

test('no page source formats a signed baseline difference', () => {
  const dir = __dirname;
  const sources = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
  for (const f of sources) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    expect({ file: f, found: /BaselineDelta|formatDelta|showDelta/.test(text) }).toEqual({ file: f, found: false });
  }
});

test('the Prep categories are coloured against the baselines the Prep team set', () => {
  // Agreed with the Tableau Prep team on 2026-10-22. A score exactly 25
  // points below the baseline is still yellow.
  const band = (v: number, key: string, capability: string) =>
    baselineTone(v, categoryBaseline(key, capability))!.key;
  const bands = ['higher', 'higher', 'little-lower', 'little-lower', 'much-lower'];
  expect([1, 0.95, 0.94, 0.7, 0.69].map((v) => band(v, 'match', 'prep-intent'))).toEqual(bands);
  expect([1, 0.85, 0.84, 0.6, 0.59].map((v) => band(v, 'calc', 'prep-calc'))).toEqual(bands);
  expect([1, 0.8, 0.79, 0.55, 0.54].map((v) => band(v, 'flowPlan', 'prep-flow-plan'))).toEqual(bands);
  // Every other capability reads all of its categories against its own
  // baseline (the baseline table of 2026-10-29); a capability without one
  // keeps the 33 / 66 bands.
  expect(categoryBaseline('calc', 'calc')).toBe(0.85);
  expect(categoryBaseline('nl', 'calc')).toBe(0.85);
  expect(categoryBaseline('data', 'viz-authoring')).toBe(0.83);
  expect(categoryBaseline('calc', 'no-such-capability')).toBeUndefined();
  expect(baselineTone(0.7, undefined)).toBeUndefined();
});

test("relabelBuckets attaches the capability's baseline to its category", () => {
  const calc = METRIC_BUCKETS.find((b) => b.key === 'calc')!;
  const bucket = { def: calc, items: [], avg: 0.7 };
  expect(relabelBuckets([bucket], 'prep-calc')[0].def.baseline).toBe(0.85);
  expect(relabelBuckets([bucket], 'calc')[0].def.baseline).toBe(0.85);
  expect(relabelBuckets([bucket], 'no-such-capability')[0].def.baseline).toBeUndefined();
});

test('a pill with a baseline tone takes its colour; one without keeps the 33 / 66 bands', () => {
  render(
    <>
      <ScorePill val={0.7} tone={baselineTone(0.7, 0.8)} />
      <ScorePill val={0.7} />
    </>,
  );
  const [toned, plain] = screen.getAllByText('70%');
  const probe = document.createElement('span');
  probe.style.color = SCORE_COLORS.medium.color;
  expect(toned.style.color).toBe(probe.style.color);
  probe.style.color = SCORE_COLORS.high.color;
  expect(plain.style.color).toBe(probe.style.color);
});
