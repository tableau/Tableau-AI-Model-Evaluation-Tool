/**
 * The test-history side panel, shared by the evaluation homepage and the
 * results page so both speak the same design language: a history icon on the
 * left edge that expands into a panel listing evaluations.
 *
 * It lists what was launched: an "Evaluate all" is one entry that expands
 * into its suites, a single Evaluate is one entry (UX-14). On the homepage
 * it lists every evaluation; on a results page it is scoped to the feature
 * of the run being viewed. Either way it offers the same tools: filter by
 * status and by feature or capability (UX-13), select entries, and delete
 * the selection — the way out of a history that has filled up with runs
 * paused and never resumed.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Checkbox, Popconfirm, Select, Tag, Tooltip, Typography, message } from './ui';
import { DeleteOutlined, DownOutlined, HistoryOutlined, MenuFoldOutlined, RightOutlined } from './ui/icons';

import { API_BASE } from './api';
import { CATEGORIES, FEATURES, categoryOfRun, featureOfRun } from './featureGroups';
import { Evaluation, RunRecord, groupEvaluations } from './evaluationGroups';
import { ACTIVE_STATUSES, RUNNING_STATUSES, runStatusInfo } from './runStatus';
import { JudgeSpark, headlineText } from './headlineScores';

const { Text } = Typography;

/** The run fields the panel reads; pages pass their run records as they are. */
export type HistoryRun = RunRecord;

export const STATUS_FILTERS: Array<{ value: string; label: string; match: (e: Evaluation) => boolean }> = [
  { value: 'all', label: 'All statuses', match: () => true },
  { value: 'active', label: 'In progress or queued', match: (e) => ACTIVE_STATUSES.includes(e.status) },
  { value: 'paused', label: 'Paused', match: (e) => e.status === 'paused' },
  { value: 'finished', label: 'Completed', match: (e) => e.status === 'finished' },
  {
    value: 'stopped',
    label: 'Failed or canceled',
    match: (e) => e.status === 'failed' || e.status === 'cancelled',
  },
];

/** Feature and capability filter options: each feature, then its capabilities indented. */
export const SCOPE_OPTIONS: Array<{ value: string; label: string; match: (e: Evaluation) => boolean }> = [
  { value: 'all', label: 'All features', match: () => true },
  ...FEATURES.flatMap((f) => [
    {
      value: `feature:${f.key}`,
      label: f.short,
      match: (e: Evaluation) => e.runs.some((r) => featureOfRun(r) === f.key),
    },
    ...CATEGORIES.filter((c) => c.feature === f.key).map((c) => ({
      value: `cat:${c.key}`,
      label: ` ${c.label}`,
      match: (e: Evaluation) => e.runs.some((r) => categoryOfRun(r).key === c.key),
    })),
  ]),
];

/** Whether the panel is open is remembered across both pages, so it does not
 *  snap shut every time the admin moves between the homepage and a run. */
const OPEN_KEY = 'ai_eval_history_open';
const readOpen = (): boolean => {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

const stamp = (iso: string | null | undefined): string => (iso || '').slice(0, 16) || 'Not started';

const statusOf = (r: { status: string; never_started?: boolean; failed_cases?: number; total?: number }) =>
  runStatusInfo(r.status, { neverStarted: r.never_started, failedCases: r.failed_cases, total: r.total });

const RunHistoryPanel: React.FC<{
  /** Panel heading, e.g. "All Evaluations" or "Tableau Prep Test History". */
  title: string;
  runs: HistoryRun[];
  /** The run whose results are on screen, highlighted in the list. */
  activeJobId?: string;
  /** Called after a delete with the ids that were removed. */
  onDeleted?: (jobIds: string[]) => void;
}> = ({ title, runs, activeJobId, onDeleted }) => {
  const [open, setOpen] = useState<boolean>(readOpen);
  const [filter, setFilter] = useState('all');
  const [scope, setScope] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const toggleOpen = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      /* private mode: the panel still works, it just is not remembered */
    }
  };

  const evaluations = useMemo(() => groupEvaluations(runs), [runs]);
  const activeFilter = STATUS_FILTERS.find((f) => f.value === filter) || STATUS_FILTERS[0];
  const activeScope = SCOPE_OPTIONS.find((f) => f.value === scope) || SCOPE_OPTIONS[0];
  const scoped = useMemo(() => evaluations.filter(activeScope.match), [evaluations, activeScope]);
  const shown = useMemo(() => scoped.filter(activeFilter.match), [scoped, activeFilter]);
  // Only features that have evaluations are offered, so the list is short.
  const scopeOptions = useMemo(
    () => SCOPE_OPTIONS.filter((o) => o.value === 'all' || evaluations.some(o.match)),
    [evaluations],
  );

  // A run that is executing has to be cancelled before it can be deleted;
  // an evaluation is selectable when none of its runs is executing.
  const selectableEvals = useMemo(
    () => shown.filter((e) => !e.runs.some((r) => RUNNING_STATUSES.includes(r.status))),
    [shown],
  );
  const selectableIds = useMemo(
    () => selectableEvals.flatMap((e) => e.runs.map((r) => r.job_id)),
    [selectableEvals],
  );

  // Drop selections that are no longer listed (deleted elsewhere, filtered out).
  useEffect(() => {
    setSelected((prev) => {
      const next = prev.filter((id) => selectableIds.includes(id));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableIds]);

  const deleteSelected = async () => {
    setDeleting(true);
    const removed: string[] = [];
    for (const id of selected) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${API_BASE}/nlq-eval/results/${id}`, { method: 'DELETE' });
        if (res.ok) removed.push(id);
      } catch {
        /* counted as not removed below */
      }
    }
    const failed = selected.length - removed.length;
    if (failed) {
      message.warning(`Deleted ${removed.length} of ${selected.length} runs; ${failed} could not be deleted`);
    } else {
      message.success(`Deleted ${removed.length} run${removed.length === 1 ? '' : 's'}`);
    }
    setSelected([]);
    setDeleting(false);
    onDeleted?.(removed);
  };

  if (runs.length === 0) return null;

  if (!open) {
    return (
      <div style={{ flexShrink: 0, position: 'sticky', top: 12 }}>
        <Tooltip title="Show test history" placement="right">
          <Button
            aria-label="Show test history"
            icon={<HistoryOutlined />}
            onClick={() => toggleOpen(true)}
          />
        </Tooltip>
      </div>
    );
  }

  const allSelected = selectableIds.length > 0 && selected.length === selectableIds.length;
  const isSelected = (e: Evaluation) => e.runs.every((r) => selected.includes(r.job_id));
  const toggleEval = (e: Evaluation, on: boolean) =>
    setSelected((prev) => {
      const ids = e.runs.map((r) => r.job_id);
      return on ? Array.from(new Set([...prev, ...ids])) : prev.filter((id) => !ids.includes(id));
    });
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** What an entry is called: the suite for a single run, the feature and
   *  suite count for an Evaluate all. */
  const entryTitle = (e: Evaluation): string => {
    if (!e.isBatch) return e.runs[0].suite_label || categoryOfRun(e.runs[0]).label;
    const feature = FEATURES.find((f) => f.key === featureOfRun(e.runs[0]));
    return `${feature ? feature.short : 'Evaluation'} · ${e.totalSuites} ${e.totalSuites === 1 ? 'suite' : 'suites'}`;
  };

  return (
    <div
      style={{
        width: 290,
        flexShrink: 0,
        borderRight: '1px solid #f0f0f0',
        paddingRight: 16,
        position: 'sticky',
        top: 12,
        maxHeight: 'calc(100vh - 80px)',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong style={{ fontSize: 15 }}>
          {title}
        </Text>
        <Tooltip title="Hide test history">
          <Button
            type="text"
            size="small"
            aria-label="Hide test history"
            icon={<MenuFoldOutlined />}
            onClick={() => toggleOpen(false)}
          />
        </Tooltip>
      </div>
      <div style={{ margin: '2px 0 10px' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {evaluations.length} evaluation{evaluations.length === 1 ? '' : 's'} · {runs.length} run{runs.length === 1 ? '' : 's'}
        </Text>
      </div>

      {scopeOptions.length > 2 && (
        <Select
          aria-label="Filter by feature or capability"
          size="small"
          value={scope}
          onChange={setScope}
          style={{ width: '100%', marginBottom: 6 }}
          options={scopeOptions.map((o) => ({
            value: o.value,
            label: `${o.label} (${evaluations.filter(o.match).length})`,
          }))}
        />
      )}
      <Select
        aria-label="Filter by status"
        size="small"
        value={filter}
        onChange={setFilter}
        style={{ width: '100%', marginBottom: 8 }}
        options={STATUS_FILTERS.map((f) => ({
          value: f.value,
          label: `${f.label} (${scoped.filter(f.match).length})`,
        }))}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          paddingLeft: 10,
        }}
      >
        <Checkbox
          checked={allSelected}
          indeterminate={selected.length > 0 && !allSelected}
          disabled={selectableIds.length === 0}
          onChange={(e) => setSelected(e.target.checked ? selectableIds : [])}
        >
          <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Select all</Text>
        </Checkbox>
        <Popconfirm
          title={`Delete ${selected.length} run${selected.length === 1 ? '' : 's'} and their results?`}
          description="This cannot be undone."
          okText="Delete"
          okButtonProps={{ danger: true }}
          disabled={selected.length === 0}
          onConfirm={deleteSelected}
        >
          <Button
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deleting}
            disabled={selected.length === 0}
          >
            Delete Selected{selected.length ? ` (${selected.length})` : ''}
          </Button>
        </Popconfirm>
      </div>

      {shown.length === 0 && (
        <Text type="secondary" style={{ fontSize: 12, paddingLeft: 10 }}>
          No evaluations match these filters.
        </Text>
      )}
      {shown.map((e) => {
        const active = Boolean(activeJobId) && e.runs.some((r) => r.job_id === activeJobId);
        const st = statusOf({ status: e.status, never_started: e.never_started, failed_cases: e.failedCases, total: e.totalCases });
        const running = e.runs.some((r) => RUNNING_STATUSES.includes(r.status));
        const isOpen = expanded.has(e.key);
        return (
          <div
            key={e.key}
            style={{
              borderRadius: 6,
              marginBottom: 4,
              background: active ? 'rgba(17, 112, 170, 0.08)' : undefined,
              border: active ? '1px solid rgba(17, 112, 170, 0.35)' : '1px solid transparent',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px' }}>
              <Tooltip title={running ? 'Cancel a running evaluation before deleting it' : undefined}>
                <Checkbox
                  aria-label={`Select ${entryTitle(e)}`}
                  checked={isSelected(e)}
                  disabled={running}
                  onChange={(ev) => toggleEval(e, ev.target.checked)}
                />
              </Tooltip>
              <Link
                to={`/results/${e.firstJobId}${e.isBatch ? '?tab=summary' : ''}`}
                className="history-entry"
                style={{ display: 'block', color: 'inherit', flex: 1, minWidth: 0 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <Text strong style={{ fontSize: 13 }} ellipsis>
                    {entryTitle(e)}
                  </Text>
                  <Tag color={st.color} style={{ fontSize: 10, marginRight: 0 }}>
                    {e.isBatch && e.status === 'finished' ? `${e.finishedSuites} of ${e.totalSuites} completed` : st.label}
                  </Tag>
                </div>
                <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  {e.model_name || 'Model not recorded'}
                  {/* No scores while the evaluation is still going. */}
                  {!ACTIVE_STATUSES.includes(e.status) && headlineText(e.headlineScores) ? (
                    <>
                      {' · '}
                      <JudgeSpark scores={e.headlineScores} />
                      {headlineText(e.headlineScores)}
                    </>
                  ) : ''}
                </Text>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {stamp(e.created_at)}
                </Text>
              </Link>
              {e.isBatch && (
                <Button
                  type="text"
                  size="small"
                  aria-label={isOpen ? 'Hide the suites of this evaluation' : 'Show the suites of this evaluation'}
                  aria-expanded={isOpen}
                  icon={isOpen ? <DownOutlined /> : <RightOutlined />}
                  onClick={() => toggleExpanded(e.key)}
                />
              )}
            </div>
            {e.isBatch && isOpen && (
              <div style={{ padding: '0 10px 8px 34px' }}>
                {e.runs.map((r) => {
                  const rs = statusOf(r);
                  return (
                    <Link
                      key={r.job_id}
                      to={`/results/${r.job_id}`}
                      className="history-entry"
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 0',
                        color: 'inherit',
                        fontWeight: r.job_id === activeJobId ? 600 : undefined,
                      }}
                    >
                      <Text style={{ fontSize: 12 }} ellipsis>
                        {r.suite_label || categoryOfRun(r).label}
                      </Text>
                      <span style={{ whiteSpace: 'nowrap', fontSize: 11 }}>
                        {!ACTIVE_STATUSES.includes(r.status) && headlineText(r.headline_scores) ? (
                          <Text type="secondary"><JudgeSpark scores={r.headline_scores} />{headlineText(r.headline_scores)} </Text>
                        ) : null}
                        <Tag color={rs.color} style={{ fontSize: 10, marginRight: 0 }}>{rs.label}</Tag>
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default RunHistoryPanel;
