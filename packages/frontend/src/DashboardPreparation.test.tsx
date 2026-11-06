import React from 'react';
import { act, fireEvent, render, screen } from './testing.cjs';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPreparation, dashboardSuitesNeedingContent } from './DashboardPreparation';
import Dashboard from './Dashboard';
import { TourProvider } from './tour/TourContext';
import type { Suite } from './launch';
import { message } from './ui';

const qa: Suite = {
  id: 'qa', content: 'qa', label: 'Insurance Claims', capability: 'dashboard-qa', adapter: 'cabu',
  runner: 'cabu-dashboard-qa', available: true, path: '/qa.yml', visibility: 'public',
  judge_capable: true, case_count: 27, estimated_seconds: 324,
};
const summary: Suite = { ...qa, id: 'summary', content: undefined, adapter: undefined,
  label: 'Dashboard summaries', capability: 'dashboard-narratives', runner: 'dashboard-viz-narrative-config' };

test('only unpublished, otherwise eligible Q&A suites need preparation', () => {
  expect(dashboardSuitesNeedingContent([qa, summary], null)).toEqual([qa]);
  expect(dashboardSuitesNeedingContent([qa], { suites: { qa: { published: true } } })).toEqual([]);
  expect(dashboardSuitesNeedingContent([{ ...qa, server_supported: false }], null)).toEqual([]);
});

test('preparation explains exclusions and opens the selected suite', () => {
  let selected: Suite | null = null;
  render(<DashboardPreparation suites={[qa]} loaded statusAvailable onSetUp={(s) => { selected = s; }} />);
  expect(screen.getByText(/Evaluate on the feature card does not include/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Set up Insurance Claims' }));
  expect(selected).toBe(qa);
});

test('a missing status response is not presented as a confirmed unpublished dashboard', () => {
  render(<DashboardPreparation suites={[qa]} loaded statusAvailable={false} onSetUp={() => {}} />);
  expect(screen.getByText('Sample dashboard status could not be checked')).toBeTruthy();
});

test('Evaluate includes unpublished dashboard suites and starts them at once; jobs publish their content', async () => {
  const original = globalThis.fetch;
  const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  const launched: string[] = [];
  let confirmLaunch: (() => void) | undefined;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url.endsWith('/nlq-eval/run') && init?.method === 'POST') {
      launched.push(JSON.parse(String(init.body)).suite_id);
      if (launched.length === 1) return new Promise<Response>(resolve => {
        confirmLaunch = () => resolve({ ok: true, status: 202,
          json: async () => ({ job_id: 'job-1', warnings: [] }) } as Response);
      });
      return json({ job_id: `job-${launched.length}`, warnings: [] });
    }
    if (url.includes('/settings/tableau')) return json({ configured: true, server_url: 'https://tableau.example', pat_name: 'p', pat_value: '****', last_verified: { ok: true, connection_ok: true, at: new Date().toISOString() } });
    if (url.includes('/settings/judge')) return json({ configured: false });
    if (url.includes('/suites')) return json({ suites: [qa, summary] });
    if (url.includes('/runs')) return json({ runs: [] });
    if (url.includes('/dashboard-content')) return json({ configured: true, suites: { qa: { published: false, workbook: 'Insurance', dashboard: 'Claims', datasources: ['Claims data'] } } });
    return json({});
  }) as unknown as typeof fetch;
  window.localStorage.setItem('ai_eval_tour_seen', '1');
  try {
    const view = render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><TourProvider autoOpen={false}><Dashboard /></TourProvider></MemoryRouter>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    fireEvent.click(screen.getAllByRole('button', { name: 'Evaluate' })[1]!);
    expect(screen.getByRole('status').textContent).toContain('Waiting for the server to confirm it');
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeTruthy();
    expect(launched).toEqual(['qa']);
    await act(async () => { confirmLaunch!(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    // No confirmation: the click queued both suites of the feature, the
    // unpublished one included (UX review, 2026-10-21).
    expect(screen.queryByText(/Run 2 Suites/)).toBeNull();
    expect(launched).toEqual(['qa', 'summary']);
    // A launch turns on the run polling; unmount so it does not outlive the
    // test and hit the next file's fetch mock.
    view.unmount();
  } finally {
    globalThis.fetch = original;
    act(() => message.destroy());
  }
});
