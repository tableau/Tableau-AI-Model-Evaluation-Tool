import React from 'react';
import { act, fireEvent, render, screen, waitFor } from './testing.cjs';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { TourProvider } from './tour/TourContext';
import { mockObservationSocket } from './testingWebSocket';
import type { RunProjection } from '@tableau-ai-eval/run-state';

describe('test results pause and resume', () => {
  it.each([
    ['running', 'queued', 'Pause all suites', 'batches/evaluation/pause'],
    ['paused', 'paused', 'Resume all paused suites', 'batches/evaluation/resume'],
  ])('a %s evaluation acts on every suite with one click', async (first, second, button, expected) => {
    const originalFetch = globalThis.fetch;
    const posts: string[] = [];
    const run = (job_id: string, status: string, i: number) => ({
      job_id, runner_name: 'ect-server', ai_feature: 'calc', status, total: 2, completed: 0,
      error: null, batch_id: 'evaluation', suite_id: `suite-${i}`, suite_label: `Suite ${i}`,
      created_at: `2026-10-21T10:00:0${i}Z`,
    });
    const runs = [run('a', first, 0), run('b', second, 1)];
    const socket = mockObservationSocket(id => ({ jobId: id, revision: 0, executionId: '',
      run: runs.find(r => r.job_id === id)!, state: {}, cases: [], results: {},
      runningIds: [], retryingIds: [] } as unknown as RunProjection));
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') posts.push(url.replace(/^.*\/nlq-eval\//, ''));
      const body = url.includes('/pause') ? { ok: true, paused: 2 }
        : url.includes('/resume') ? { ok: true, resumed: 2 }
        : url.includes('/runs') ? { filtered: true, runs }
        : url.includes('/suites') ? { suites: [] } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as typeof fetch;
    try {
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <TourProvider autoOpen={false}><Dashboard /></TourProvider>
        </MemoryRouter>,
      );
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
      fireEvent.click(screen.getAllByText('Tableau Agent in Authoring')[0]);
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: button }));
      });
      await waitFor(() => expect(posts).toEqual([expected]));
    } finally {
      act(() => socket.restore());
      globalThis.fetch = originalFetch;
    }
  });
});

describe('test results cancel', () => {
  it.each([['running', 'queued'], ['paused', 'paused']])('cancels every suite of a %s evaluation, not just one', async (first, second) => {
    const originalFetch = globalThis.fetch;
    const posts: string[] = [];
    const run = (job_id: string, status: string, i: number) => ({
      job_id, runner_name: 'ect-server', ai_feature: 'calc', status, total: 2, completed: 0,
      error: null, batch_id: 'evaluation', suite_id: `suite-${i}`, suite_label: `Suite ${i}`,
      created_at: `2026-10-21T10:00:0${i}Z`,
    });
    const runs = [run('a', first, 0), run('b', second, 1)];
    const socket = mockObservationSocket(id => ({ jobId: id, revision: 0, executionId: '',
      run: runs.find(r => r.job_id === id)!, state: {}, cases: [], results: {},
      runningIds: [], retryingIds: [] } as unknown as RunProjection));
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') posts.push(url.replace(/^.*\/nlq-eval\//, ''));
      const body = url.includes('/cancel') ? { ok: true, cancelled: 2 }
        : url.includes('/runs') ? { filtered: true, runs }
        : url.includes('/suites') ? { suites: [] } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as typeof fetch;
    try {
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <TourProvider autoOpen={false}><Dashboard /></TourProvider>
        </MemoryRouter>,
      );
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
      fireEvent.click(screen.getAllByText('Tableau Agent in Authoring')[0]);
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel all suites' }));
      expect(await screen.findByText('Cancel all unfinished suites? Completed cases are kept.')).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      });
      await waitFor(() => expect(posts).toEqual(['batches/evaluation/cancel']));
    } finally {
      act(() => socket.restore());
      globalThis.fetch = originalFetch;
    }
  });
});
