/**
 * Launching from the home page (bug bash 2026-10-23): Evaluate All runs
 * every feature's suites as one batch per feature, nothing navigates away,
 * and while an evaluation is queued or running the launch buttons and the
 * setup steps are disabled.
 */
import React from 'react';
import { act, fireEvent, render, screen } from './testing.cjs';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import { TourProvider } from './tour/TourContext';
import type { Suite } from './launch';
import { message } from './ui';
import { mockObservationSocket } from './testingWebSocket';
import type { RunProjection } from '@tableau-ai-eval/run-state';

const calc: Suite = {
  id: 'calc-public', label: 'Calculated fields', capability: 'calc', runner: 'calc-prompt',
  available: true, path: '/calc', visibility: 'public', judge_capable: true, case_count: 10, estimated_seconds: 60,
};
const intent: Suite = {
  id: 'prep-intent-public', label: 'Understand the request', capability: 'prep-intent', runner: 'prep-intent-gen',
  available: true, path: '/intent', visibility: 'public', judge_capable: false, case_count: 5, estimated_seconds: 30,
};

const Probe: React.FC = () => <div data-testid="path">{useLocation().pathname}</div>;
const settle = (ms = 250) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

test('Evaluate All queues one batch per feature and stays on the page; everything launchable is then disabled', async () => {
  const original = globalThis.fetch;
  const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  const posts: Array<Record<string, unknown>> = [];
  let runs: Array<Record<string, unknown>> = [];
  // The page watches active runs over a WebSocket; a fixture stands in.
  const socket = mockObservationSocket((id) => ({ jobId: id, revision: 0, executionId: '',
    run: runs.find((r) => r.job_id === id)!, state: {}, cases: [], results: {},
    runningIds: [], retryingIds: [] } as unknown as RunProjection));
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url.endsWith('/nlq-eval/run') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      runs = [...runs, {
        job_id: `job-${posts.length}`, status: 'queued', suite_id: body.suite_id, suite_label: body.suite_label,
        runner_name: body.runner, ai_feature: body.ai_feature, total: 0, completed: 0, error: null,
        created_at: `2026-10-27T10:00:0${posts.length}Z`, batch_id: body.batch_id,
      }];
      return json({ job_id: `job-${posts.length}`, warnings: [] });
    }
    if (url.includes('/settings/tableau')) return json({ configured: true, server_url: 'https://tableau.example', pat_name: 'p', pat_value: '****', last_verified: { ok: true, connection_ok: true, at: new Date().toISOString() } });
    if (url.includes('/settings/judge')) return json({ configured: false, evaluated_model_family: null });
    if (url.includes('/suites')) return json({ suites: [calc, intent] });
    // `filtered`: the server already applied the public-suite rule, as the
    // real one does; without it the page filters by a cached suite list.
    if (url.includes('/runs')) return json({ runs, filtered: true });
    if (url.includes('/dashboard-content')) return json({ configured: true, suites: {} });
    return json({});
  }) as unknown as typeof fetch;
  window.localStorage.setItem('ai_eval_tour_seen', '1');
  try {
    const view = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TourProvider autoOpen={false}><Dashboard /><Probe /></TourProvider>
      </MemoryRouter>,
    );
    await settle();
    const start = screen.getByRole('button', { name: 'Evaluate All' }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await settle(100);

    // One batch per feature, in feature order, and no "all features" batch.
    expect(posts.map((p) => p.suite_id)).toEqual(['calc-public', 'prep-intent-public']);
    expect(posts[0]!.batch_id).toBeTruthy();
    expect(posts[1]!.batch_id).toBeTruthy();
    expect(posts[0]!.batch_id).not.toBe(posts[1]!.batch_id);
    expect(screen.getByTestId('path').textContent).toBe('/');

    // The queued runs freeze the launch buttons and the setup steps. The
    // list refresh after a launch is deduplicated, so wait for the one-second
    // poll a launch turns on.
    const startButton = () => screen.getByRole('button', { name: 'Evaluate All' }) as HTMLButtonElement;
    for (let i = 0; i < 20 && !startButton().disabled; i += 1) await settle(200);
    expect(startButton().disabled).toBe(true);
    const evaluates = screen.getAllByRole('button', { name: 'Evaluate' }) as HTMLButtonElement[];
    expect(evaluates.length).toBeGreaterThan(0);
    expect(evaluates.every((b) => b.disabled)).toBe(true);
    const changes = screen.getAllByRole('button', { name: 'Change' }) as HTMLButtonElement[];
    expect(changes.length).toBe(1);
    expect(changes[0]!.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
  } finally {
    socket.restore();
    globalThis.fetch = original;
    act(() => message.destroy());
  }
});

test("a feature whose suites the server keeps out says why on its disabled Evaluate button", async () => {
  // Tableau Agent in Authoring off on the site: the suite list carries the
  // reason, and the card's Evaluate repeats it instead of "No suites
  // available on this machine", which would send the admin to the wrong fix.
  const original = globalThis.fetch;
  const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  const reason = "Tableau Agent in Authoring is turned off for this site, so the Build a visualization, Calculated fields and Color palettes suites can't run here. A site administrator turns it on in Site Settings (Tableau Agent in web authoring), then test the connection again.";
  const socket = mockObservationSocket(() => ({}) as unknown as RunProjection);
  globalThis.fetch = ((url: string) => {
    if (url.includes('/settings/tableau')) return json({ configured: true, server_url: 'https://tableau.example', pat_name: 'p', pat_value: '****', last_verified: { ok: true, connection_ok: true, at: new Date().toISOString() } });
    if (url.includes('/settings/judge')) return json({ configured: false, evaluated_model_family: null });
    if (url.includes('/suites')) return json({ suites: [{ ...calc, server_supported: false, server_message: reason }, intent], web_authoring_off: { message: reason } });
    if (url.includes('/runs')) return json({ runs: [], filtered: true });
    if (url.includes('/dashboard-content')) return json({ configured: true, suites: {} });
    return json({});
  }) as unknown as typeof fetch;
  window.localStorage.setItem('ai_eval_tour_seen', '1');
  try {
    const view = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TourProvider autoOpen={false}><Dashboard /></TourProvider>
      </MemoryRouter>,
    );
    await settle();
    const evaluates = screen.getAllByRole('button', { name: 'Evaluate' }) as HTMLButtonElement[];
    const authoring = evaluates.find((b) => b.disabled)!;
    expect(authoring).toBeTruthy();
    fireEvent.mouseEnter(authoring.parentElement!);
    await settle(50);
    expect(screen.getByRole('tooltip').textContent).toContain('Tableau Agent in Authoring is turned off');
    expect(screen.queryByText('No suites available on this machine')).toBeNull();
    // The other feature still launches: Evaluate All stays available.
    expect((screen.getByRole('button', { name: 'Evaluate All' }) as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  } finally {
    socket.restore();
    globalThis.fetch = original;
    act(() => message.destroy());
  }
});

test("a feature's Evaluate hover names the suites the server keeps out beside the ones it runs", async () => {
  // Tableau Agent in Dashboards off on the site while Dashboard Narratives
  // still runs: the batch is one suite, and the hover says which suite is
  // left out and why, instead of listing only what runs (2026-11-04).
  const original = globalThis.fetch;
  const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  const reason = "Tableau Agent in Dashboards is turned off for this site, so the Questions about a dashboard suites can't run here. A site administrator turns it on in Site Settings (Tableau Agent in Dashboards), then test the connection again.";
  const narratives: Suite = {
    id: 'dashboard-narratives-public', label: 'Dashboard Narratives', capability: 'dashboard-narratives', runner: 'narratives',
    available: true, path: '/narratives', visibility: 'public', judge_capable: true, case_count: 17, estimated_seconds: 180,
  };
  const qa: Suite = {
    id: 'dashboard-qa-public', label: 'Questions about a dashboard', capability: 'dashboard-qa', runner: 'cabu',
    available: true, path: '/qa', visibility: 'public', judge_capable: true, case_count: 923, estimated_seconds: 10800,
    server_supported: false, server_message: reason,
  };
  const socket = mockObservationSocket(() => ({}) as unknown as RunProjection);
  globalThis.fetch = ((url: string) => {
    if (url.includes('/settings/tableau')) return json({ configured: true, server_url: 'https://tableau.example', pat_name: 'p', pat_value: '****', last_verified: { ok: true, connection_ok: true, at: new Date().toISOString() } });
    if (url.includes('/settings/judge')) return json({ configured: false, evaluated_model_family: null });
    if (url.includes('/suites')) return json({ suites: [narratives, qa], dashboard_qa_off: { message: reason } });
    if (url.includes('/runs')) return json({ runs: [], filtered: true });
    if (url.includes('/dashboard-content')) return json({ configured: true, suites: {} });
    return json({});
  }) as unknown as typeof fetch;
  window.localStorage.setItem('ai_eval_tour_seen', '1');
  try {
    const view = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TourProvider autoOpen={false}><Dashboard /></TourProvider>
      </MemoryRouter>,
    );
    await settle();
    const evaluates = screen.getAllByRole('button', { name: 'Evaluate' }) as HTMLButtonElement[];
    const dashboards = evaluates.find((b) => !b.disabled)!;
    expect(dashboards).toBeTruthy();
    fireEvent.mouseEnter(dashboards.parentElement!);
    await settle(50);
    const tip = screen.getByRole('tooltip').textContent || '';
    expect(tip).toContain('Runs this suite');
    expect(tip).toContain('Dashboard Narratives: 17 test cases');
    expect(tip).toContain('Not run: Questions about a dashboard.');
    expect(tip).toContain('Tableau Agent in Dashboards is turned off');
    view.unmount();
  } finally {
    socket.restore();
    globalThis.fetch = original;
    act(() => message.destroy());
  }
});
