/**
 * Launching an evaluation, shared by the home page and the feature results
 * page so a suite starts the same way from either.
 *
 * Everything a customer-path run needs is already configured: the Tableau
 * connection is stored, and Site Settings resolves the model. The payload
 * carries the suite's identity (so runs are labelled by suite everywhere),
 * the harness details the backend needs, and a batch id when several suites
 * are launched together.
 */

import { API_BASE } from './api';

export interface Suite {
  id: string;
  label: string;
  capability: string;
  runner: string;
  /** Harness adapter serving this suite ("prep_server" for the Prep suites);
   *  absent/nlq = the default NLQ evaluator harness. */
  adapter?: string;
  judge_capable: boolean;
  visibility: 'public';
  /** Dev smoke / oversized suites stay API-runnable but off the UI. */
  ui_hidden?: boolean;
  /** Placeholder for a capability whose suite is not available yet: listed, never runnable. */
  coming_soon?: boolean;
  /** Questions about a dashboard: the id of the sample content the suite asks
   *  about (public-suites/dashboard-qa/content.json), published by the tool. */
  content?: string;
  /** A suite made of other suites (Questions about a dashboard): each part's
   *  id, label, sample content id and case count. */
  parts?: Array<{ id: string; label: string; content?: string; case_count: number }>;
  /** The suite's requests go through the Tableau Server under test (every suite today). */
  server_routed?: boolean;
  /** False when the connected server's release is earlier than 2026.3, the first
   *  with the AI endpoint: the suite is listed but can't run, and
   *  `server_message` says why. */
  server_supported?: boolean;
  server_message?: string | null;
  available: boolean;
  path: string | null;
  case_count: number;
  estimated_seconds: number;
  /** Baseline overall score (0-1) Tableau's default model reached on this
   *  suite on the reference build; provisional until the reference run is
   *  published. */
  baseline?: number | null;
  baseline_provisional?: boolean;
}

/** Metrics config follows the test-case TYPE (calc vs viz), not the runner.
 *  Color palettes and Dashboard Narratives need none: the tool scores them
 *  itself. */
export const METRICS_BY_CAPABILITY: Record<string, string> = {
  calc: 'byollm_metrics',
  'viz-authoring': 'byollm_viz_metrics',
};

/** The browser could not reach the tool's server at all. */
export const NETWORK_ERROR_TEXT =
  "The tool's server did not answer. Check that it is still running in the terminal " +
  'where you started it, then try again.';

/** A response with no explanation of its own, in words that say where to look. */
export const httpErrorText = (status: number, path?: string): string => {
  const where = path ? ` (${path})` : '';
  if (status >= 500) {
    return `The tool's server hit an error${where}: HTTP ${status}. Its terminal output says what went wrong.`;
  }
  if (status === 404) {
    return `The tool's server has nothing at this address${where}: HTTP 404. Reload the page; if that does not help, the page and the server are different builds.`;
  }
  return `The tool's server refused the request${where}: HTTP ${status}.`;
};

export const jfetch = async (path: string, init?: RequestInit) => {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new Error(NETWORK_ERROR_TEXT);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || httpErrorText(res.status, path));
  return body;
};

/** One id shared by every suite in a launch — the results page uses it to
 *  show the batch as tabs rather than as unrelated runs. */
export const newBatchId = (): string =>
  `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Payload for a customer-path run of one suite. */
export const runPayloadFor = (
  suite: Suite,
  opts: { judgeReady: boolean; batchId?: string },
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    suite_id: suite.id,
    suite_label: suite.label,
    ...(opts.batchId ? { batch_id: opts.batchId } : {}),
    runner: suite.runner,
    ai_feature: suite.capability,
    test_path: suite.path,
    // Judge-scored metrics whenever the suite supports them and a judge
    // is configured; deterministic metrics always run regardless.
    compute_nl_judge: Boolean(suite.judge_capable && opts.judgeReady),
    generations_mode: 'ces',
  };
  if (suite.adapter && suite.adapter !== 'nlq') payload.adapter = suite.adapter;
  const metrics = METRICS_BY_CAPABILITY[suite.capability];
  if (metrics) payload.metrics_file = metrics;
  return payload;
};

/** POST one suite; resolves to the new job id and any warnings the
 *  server attached to the run (a judge from the model's own family). */
export const launchSuite = async (
  suite: Suite,
  opts: { judgeReady: boolean; batchId?: string },
): Promise<{ jobId: string; warnings: string[] }> => {
  const body = await jfetch('/nlq-eval/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(runPayloadFor(suite, opts)),
  });
  return { jobId: body.job_id as string, warnings: (body.warnings as string[]) || [] };
};

/** Whether a judge is configured (the only launch-time input besides the suite). */
export const fetchJudgeReady = async (): Promise<boolean> => {
  try {
    const judge = await jfetch('/nlq-eval/settings/judge');
    return Boolean(judge.configured);
  } catch {
    return false;
  }
};
