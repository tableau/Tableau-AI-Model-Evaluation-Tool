import React from 'react';
import { act, render, screen } from './testing.cjs';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { TourProvider } from './tour/TourContext';
import { mockObservationSocket } from './testingWebSocket';
import type { RunProjection } from '@tableau-ai-eval/run-state';

/** The feature card's "Last run" is the newest evaluation whatever its
 *  state, with that state beside the time; "Not yet tested" is only for a
 *  feature with no run at all. */
describe('feature card last run', () => {
  const run = (job_id: string, status: string, i: number, finished_at: string | null = null) => ({
    job_id, runner_name: 'ect-server', ai_feature: 'calc', status, total: 2, completed: status === 'finished' ? 2 : 0,
    error: null, batch_id: 'evaluation', suite_id: `suite-${i}`, suite_label: `Suite ${i}`,
    created_at: `2026-11-03 19:47:0${i}`, finished_at,
  });

  const renderWith = async (runs: ReturnType<typeof run>[]) => {
    const originalFetch = globalThis.fetch;
    const socket = mockObservationSocket(id => ({ jobId: id, revision: 0, executionId: '',
      run: runs.find(r => r.job_id === id)!, state: {}, cases: [], results: {},
      runningIds: [], retryingIds: [] } as unknown as RunProjection));
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/runs') ? { filtered: true, runs }
        : url.includes('/suites') ? { suites: [] } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as typeof fetch;
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TourProvider autoOpen={false}><Dashboard /></TourProvider>
      </MemoryRouter>,
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    return () => { act(() => socket.restore()); globalThis.fetch = originalFetch; };
  };

  it.each([
    ['paused', 'Paused'],
    ['running', 'In progress'],
    ['finished', 'Completed'],
  ])('a feature whose latest evaluation is %s shows its time and that state', async (status, label) => {
    const done = await renderWith([run(`${status}-a`, status, 0, status === 'finished' ? '2026-11-03 19:50:00' : null),
      run(`${status}-b`, status, 1, status === 'finished' ? '2026-11-03 19:51:00' : null)]);
    try {
      expect(screen.getAllByText('Last run:').length).toBeGreaterThan(0);
      // The icon alone, named for screen readers; no status word on the line.
      const status = screen.getByTestId('feature-last-run-status');
      expect(status.getAttribute('aria-label')).toBe(label);
      expect(status.textContent).toBe('');
      expect(status.querySelector('svg')).not.toBeNull();
      expect(screen.queryAllByText('Not yet tested').length).toBe(2);  // the two other features
    } finally {
      done();
    }
  });

  it('a feature with no run says Not yet tested', async () => {
    const done = await renderWith([]);
    try {
      expect(screen.queryAllByText('Last run:').length).toBe(0);
      expect(screen.queryAllByText('Not yet tested').length).toBe(3);
    } finally {
      done();
    }
  });
});
