/**
 * One status vocabulary for every surface that shows a run: the dashboard's
 * section headers and history tables, the results header, and the test
 * history side panel.
 *
 * A run that completed is "Completed", never "Passed": no pass/fail threshold
 * is applied to a run, so "Passed" claimed a verdict nothing had reached.
 * How well the run did is the score shown beside the status.
 */

import React from 'react';
import {
  CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, LoadingOutlined,
  MinusCircleOutlined, PauseCircleFilled,
} from './ui/icons';

import { DANGER_COLOR, PRIMARY_COLOR } from './components/designSystem';

/** Statuses of a run that is executing or waiting its turn. */
export const ACTIVE_STATUSES = ['queued', 'started', 'running'];
/** Statuses of a run that is executing right now. */
export const RUNNING_STATUSES = ['started', 'running'];

export interface RunStatusInfo {
  label: string;
  /** antd Tag color. */
  color: string;
  icon: React.ReactNode;
}

/**
 * A status in a table cell: the state on the first line ("Completed"), the
 * detail on a second, secondary line ("7 errors"), so a long status never
 * runs into the next column (2026-10-19: "Completed with 10 errors" ran over
 * the Results column of the history table).
 */
export const StatusCell: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => {
  const m = /^(Completed) with (.+)$/.exec(label) || /^(Failed): (.+)$/.exec(label);
  return (
    <span className="status-cell">
      {icon}
      <span className="status-cell-text">
        <span>{m ? m[1] : label}</span>
        {m && <span className="status-cell-detail">{m[2]}</span>}
      </span>
    </span>
  );
};

export function runStatusInfo(
  status: string | null | undefined,
  opts?: {
    neverStarted?: boolean;
    /** Cases that produced no result because of an error, and the run's total.
     *  A run that ran to the end with errors still "finished", but it must not
     *  read as a clean completion: every case erroring is a failed run. */
    failedCases?: number;
    total?: number;
  },
): RunStatusInfo {
  if (status === 'finished') {
    const failed = opts?.failedCases ?? 0;
    if (failed > 0 && opts?.total && failed >= opts.total)
      return {
        label: 'Failed: every test case had an error',
        color: 'error',
        icon: <CloseCircleFilled style={{ color: DANGER_COLOR }} />,
      };
    if (failed > 0)
      return {
        label: `Completed with ${failed} error${failed === 1 ? '' : 's'}`,
        // Same green check as a clean completion (decision of 2026-10-07): the
        // label says how many cases errored; no separate colour for it.
        color: 'success',
        icon: <CheckCircleFilled style={{ color: '#389E0D' }} />,
      };
    return { label: 'Completed', color: 'success', icon: <CheckCircleFilled style={{ color: '#389E0D' }} /> };
  }
  if (status === 'failed')
    return { label: 'Failed', color: 'error', icon: <CloseCircleFilled style={{ color: DANGER_COLOR }} /> };
  if (status === 'paused')
    return { label: 'Paused', color: 'warning', icon: <PauseCircleFilled style={{ color: '#D48806' }} /> };
  if (status === 'cancelled')
    return {
      label: opts?.neverStarted ? 'Did not start' : 'Canceled',
      color: 'default',
      icon: <MinusCircleOutlined style={{ color: '#8C8C8C' }} />,
    };
  if (status === 'started' || status === 'running')
    return { label: 'In progress', color: 'processing', icon: <LoadingOutlined style={{ color: PRIMARY_COLOR }} /> };
  // A run we have no status for yet is waiting, not running; and a status
  // word this UI does not know is shown as itself rather than disguised as
  // Running (that disguise is how the home page and the results page came
  // to disagree, bug bash 2026-09-23).
  if (!status || status === 'queued')
    return { label: 'Queued', color: 'default', icon: <ClockCircleOutlined style={{ color: '#8C8C8C' }} /> };
  return {
    label: status.charAt(0).toUpperCase() + status.slice(1),
    color: 'default',
    icon: <ClockCircleOutlined style={{ color: '#8C8C8C' }} />,
  };
}

/** A run that Resume can continue: paused, or stopped by a failure with
 *  questions still unasked (an outage met the breaker). */
export function isResumableRun(r: { status?: string; total?: number | null; completed?: number | null } | null | undefined): boolean {
  if (!r) return false;
  if (r.status === 'paused') return true;
  return r.status === 'failed' && (r.total || 0) > (r.completed || 0);
}
