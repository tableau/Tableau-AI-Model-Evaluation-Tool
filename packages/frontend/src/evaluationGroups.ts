/**
 * Runs as the admin launched them: an "Evaluate all" is one evaluation with
 * a run per suite, a single Evaluate is one evaluation with one run. The
 * home page's test-results tables and the feature results page both read
 * this grouping, so an evaluation is one row and one page everywhere.
 */

import { CATEGORIES, CategoryDef } from './featureGroups';
import type { Suite } from './launch';
import { ACTIVE_STATUSES, RUNNING_STATUSES } from './runStatus';

export interface RunRecord {
  job_id: string;
  runner_name: string;
  ai_feature: string;
  status: string;
  total: number;
  completed: number;
  error: string | null;
  created_at: string;
  finished_at?: string | null;
  model_name?: string;
  judge_provider?: string;
  pause_reason?: string;
  /** Committed preparation/publishing phase from the run observation store. */
  phase?: string | null;
  /** Cases that errored with no result, and the most common error text (finished runs). */
  failed_cases?: number;
  dominant_error?: string | null;
  /** Suite identity from the launch, and the batch it was launched in. */
  suite_id?: string | null;
  suite_label?: string | null;
  batch_id?: string | null;
  /** Closed out at boot: a restart happened while it was still queued. */
  never_started?: boolean;
  /** The catalog's weighted overall (0-1) and how many metrics scored. */
  score?: number | null;
  scored_metrics?: number;
  /** The capability's own averages, in display order: what the home page lists. */
  headline_scores?: HeadlineScore[];
}

/** One headline average of a run (a quality card or a weighted category). */
export interface HeadlineScore {
  key: string;
  label: string;
  average: number | null;
  /** The suite the score came from, so it can be read against that suite's baseline. */
  suite_id?: string | null;
  /** How many metrics the average is over, and how many of them the LLM
   *  judge scored: a judge-on run and a judge-off run of the same suite
   *  average different metrics. */
  total_scores?: number;
  judge_scores?: number;
  /** Categories listed with this score for reference and left out of its
   *  average (Intent and Spec beside Visualization Quality). */
  context?: HeadlineScore[];
}

export interface Evaluation {
  /** The batch id, or the job id of a single-suite evaluation. */
  key: string;
  isBatch: boolean;
  /** Launch order. */
  runs: RunRecord[];
  /** The page that shows the whole evaluation (tabs for a batch). */
  firstJobId: string;
  created_at: string;
  /** Set once every run has ended. */
  finished_at: string | null;
  /** The most urgent member status: running, paused, queued, failed, cancelled, finished. */
  status: string;
  finishedSuites: number;
  totalSuites: number;
  completedCases: number;
  totalCases: number;
  failedCases: number;
  /** Mean of the member runs' weighted overalls (0-1), or null when none is scored. */
  score: number | null;
  /** One suite: its headline averages. An Evaluate all: each suite's own
   *  main measure only (the rest is on the suite's row), never a blend
   *  across capabilities. */
  headlineScores: HeadlineScore[];
  model_name: string;
  judge_provider: string;
  never_started: boolean;
}

const TERMINAL = new Set(['finished', 'failed', 'cancelled']);

/** The status an evaluation reads as: anything still going first, then
 *  anything waiting on the admin, and "finished" only when every run is. */
export function evaluationStatus(runs: RunRecord[]): string {
  if (runs.some((r) => RUNNING_STATUSES.includes(r.status))) return 'running';
  if (runs.some((r) => r.status === 'paused')) return 'paused';
  if (runs.some((r) => r.status === 'queued')) return 'queued';
  if (runs.some((r) => r.status === 'failed')) return 'failed';
  if (runs.every((r) => r.status === 'cancelled')) return 'cancelled';
  return 'finished';
}

/** Launch order. A run with no timestamp yet (still queued on an older
 *  server) goes after the runs that have one. */
const byLaunchOrder = (a: RunRecord, b: RunRecord) => {
  const ta = String(a.created_at || '');
  const tb = String(b.created_at || '');
  if (!ta || !tb) return ta ? -1 : tb ? 1 : 0;
  return ta.localeCompare(tb);
};

const isLive = (e: Evaluation): boolean => ACTIVE_STATUSES.includes(e.status);

/** The headline averages an evaluation's row lists. One suite: all of its
 *  own. Several suites: each suite's main measure (its first headline
 *  score), in launch order; secondary measures such as Intent & Spec mean
 *  different things per capability and stay on the suite's own row. Two
 *  suites of the same capability share a key and average. */
export function evaluationHeadlineScores(runs: RunRecord[]): HeadlineScore[] {
  const scored = (r: RunRecord) =>
    (r.headline_scores || []).filter((h) => h.average != null).map((h) => ({ ...h, suite_id: r.suite_id }));
  if (runs.length === 1) return scored(runs[0]);
  const acc = new Map<string, { label: string; sum: number; n: number; suite_id?: string | null; total: number; judge: number }>();
  for (const r of runs) {
    const main = scored(r)[0];
    if (!main) continue;
    const cur = acc.get(main.key) || { label: main.label, sum: 0, n: 0, suite_id: r.suite_id, total: 0, judge: 0 };
    cur.sum += main.average as number;
    cur.n += 1;
    cur.total += main.total_scores || 0;
    cur.judge += main.judge_scores || 0;
    acc.set(main.key, cur);
  }
  return Array.from(acc.entries()).map(([k, v]) => ({
    key: k, label: v.label, average: v.sum / v.n, suite_id: v.suite_id,
    total_scores: v.total, judge_scores: v.judge,
  }));
}

function buildEvaluation(key: string, isBatch: boolean, members: RunRecord[]): Evaluation {
  const runs = [...members].sort(byLaunchOrder);
  const scored = runs.filter((r) => r.score != null);
  const allEnded = runs.every((r) => TERMINAL.has(r.status));
  const ends = runs.map((r) => r.finished_at || '').filter(Boolean).sort();
  return {
    key,
    isBatch,
    runs,
    firstJobId: runs[0].job_id,
    created_at: runs.map((r) => r.created_at).find(Boolean) || '',
    finished_at: allEnded && ends.length ? ends[ends.length - 1] : null,
    status: evaluationStatus(runs),
    finishedSuites: runs.filter((r) => r.status === 'finished').length,
    totalSuites: runs.length,
    completedCases: runs.reduce((n, r) => n + (r.completed || 0), 0),
    totalCases: runs.reduce((n, r) => n + (r.total || 0), 0),
    failedCases: runs.reduce((n, r) => n + (r.failed_cases || 0), 0),
    score: scored.length
      ? scored.reduce((s, r) => s + (r.score as number), 0) / scored.length
      : null,
    headlineScores: evaluationHeadlineScores(runs),
    model_name: runs.map((r) => r.model_name).find(Boolean) || '',
    judge_provider: runs.map((r) => r.judge_provider).find(Boolean) || '',
    never_started: runs.every((r) => r.never_started),
  };
}

/** Group runs into evaluations: anything running or queued first, then
 *  newest first, so what is happening now is never below the fold. */
export function groupEvaluations(runs: RunRecord[]): Evaluation[] {
  const batches = new Map<string, RunRecord[]>();
  const order: Array<{ key: string; isBatch: boolean }> = [];
  for (const r of runs) {
    const key = r.batch_id || r.job_id;
    if (!batches.has(key)) {
      batches.set(key, []);
      order.push({ key, isBatch: Boolean(r.batch_id) });
    }
    batches.get(key)!.push(r);
  }
  return order
    .map(({ key, isBatch }) => buildEvaluation(key, isBatch, batches.get(key)!))
    .sort((a, b) => {
      const live = Number(isLive(b)) - Number(isLive(a));
      if (live) return live;
      return String(b.created_at).localeCompare(String(a.created_at));
    });
}

/** The newest evaluation that ran to the end: the one a headline score
 *  comes from (a paused or queued run has no result to headline). */
export function latestFinished(evals: Evaluation[]): Evaluation | undefined {
  return evals.find((e) => e.status === 'finished' && e.score != null)
    || evals.find((e) => e.status === 'finished');
}

/** The newest evaluation of all, whatever its state: the feature card's
 *  "Last run" (a paused or running evaluation is still the last one). */
export function latestEvaluation(evals: Evaluation[]): Evaluation | undefined {
  return evals.reduce<Evaluation | undefined>(
    (best, e) => (!best || String(e.created_at) > String(best.created_at) ? e : best),
    undefined,
  );
}

/** The newest evaluation still going or waiting on the admin, if it is
 *  newer than the latest finished one: shown as a status chip beside the
 *  headline, never instead of it. */
export function latestLive(evals: Evaluation[]): Evaluation | undefined {
  const live = evals.find((e) => ACTIVE_STATUSES.includes(e.status) || e.status === 'paused');
  if (!live) return undefined;
  const finished = latestFinished(evals);
  if (finished && String(finished.created_at) > String(live.created_at)) return undefined;
  return live;
}

/** Smoke suites are for a quick check of the setup, not for a result. */
export const isSmokeSuite = (s: Suite): boolean => s.id.startsWith('sample-');

/**
 * The public full suite of a capability: the one whose results stand for
 * that capability on the feature results page (decision of 2026-09-30: only
 * the public full suite counts, never a smoke suite). Returns
 * the coming-soon placeholder when a suite is not available yet, so the
 * caller can say so; undefined when the capability has nothing listed.
 */
export function publicFullSuite(cat: CategoryDef, suites: Suite[]): Suite | undefined {
  const mine = suites.filter(
    (s) => cat.capabilities.includes(s.capability) && s.visibility === 'public' && !s.ui_hidden,
  );
  const runnable = mine.filter((s) => s.available && s.path && !isSmokeSuite(s));
  return (
    runnable.find((s) => s.id.endsWith('-public')) ||
    runnable[0] ||
    mine.find((s) => s.coming_soon) ||
    mine[0]
  );
}

/** The category a suite belongs to. */
export function categoryOfSuiteId(suiteId: string | null | undefined, suites: Suite[]): CategoryDef | undefined {
  const s = suites.find((x) => x.id === suiteId);
  return s ? CATEGORIES.find((c) => c.capabilities.includes(s.capability)) : undefined;
}
