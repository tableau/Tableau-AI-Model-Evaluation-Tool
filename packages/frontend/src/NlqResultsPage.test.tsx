import React from 'react';
import { expect, spyOn, test } from 'bun:test';
import { act, fireEvent, render, screen, waitFor } from './testing.cjs';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import NlqResultsPage from './NlqResultsPage';
import { message } from './ui';
import { mockObservationSocket } from './testingWebSocket';
import type { RunProjection } from '@tableau-ai-eval/run-state';

test('suite tabs keep independent current pages when switching runs and returning', async () => {
  const original = globalThis.fetch;
  const runs = [0, 1].map(i => ({
    job_id: `suite-pages-${i}`, status: 'finished', batch_id: 'suite-pages',
    suite_id: 'calcs-public', suite_label: `Pagination suite ${i}`, runner_name: 'ect-server', ai_feature: 'calc',
    total: 101, completed: 101, config: { batch_id: 'suite-pages' }, created_at: `2026-10-20 00:00:0${i}`,
  }));
  const socket = mockObservationSocket(id => ({ jobId: id, revision: 0, executionId: '',
    run: runs.find(r => r.job_id === id)!, state: {},
    cases: Array.from({ length: 101 }, (_, i) => ({ test_case_id: `${id}-case-${i}`,
      runner: 'ect-server', datasource: '', utterance: `Request ${i + 1}`, expected: {} })),
    results: {}, runningIds: [], retryingIds: [] } as RunProjection));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes('/runs')) body = { runs };
    else if (url.includes('/suites')) body = { suites: [] };
    else if (url.includes('/summary/')) body = { headline_scores: [], categories: [] };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const view = render(
    <MemoryRouter initialEntries={['/results/suite-pages-0?tab=runner']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/results/:jobId" element={<NlqResultsPage />} /></Routes>
    </MemoryRouter>,
  );
  try {
    await screen.findAllByText('Page 1 of 3');
    fireEvent.click(screen.getAllByRole('button', { name: 'Last page' })[0]);
    expect(screen.getAllByText('Page 3 of 3')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: /Pagination suite 1/i }));
    await screen.findAllByText('Page 1 of 3');
    fireEvent.click(screen.getAllByRole('button', { name: 'Next page' })[0]);
    expect(screen.getAllByText('Page 2 of 3')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: /Pagination suite 0/i }));
    await screen.findAllByText('Page 3 of 3');
    fireEvent.click(screen.getByRole('tab', { name: /Pagination suite 1/i }));
    await screen.findAllByText('Page 2 of 3');
  } finally {
    view.unmount();
    socket.restore();
    globalThis.fetch = original;
  }
});

for (const pausedOnly of [false, true]) {
test(`header cancel on a runner tab cancels the whole batch (${pausedOnly ? 'paused' : 'running'} siblings)`, async () => {
  const original = globalThis.fetch;
  const success = spyOn(message, 'success').mockImplementation(() => {});
  const cancelled: string[] = [];
  const runs = ['finished', pausedOnly ? 'paused' : 'started', pausedOnly ? 'paused' : 'queued', 'paused', 'failed'].map((status, i) => ({
    job_id: `bulk-cancel-${i}`, status, batch_id: 'evaluation', suite_id: 'calcs-public',
    suite_label: `Suite ${i}`, runner_name: 'ect-server', ai_feature: 'calc',
    total: 1, completed: status === 'finished' ? 1 : 0, config: { batch_id: 'evaluation' },
    created_at: `2026-10-20 00:00:0${i}`,
  }));
  const socket = mockObservationSocket(id => ({ jobId: id, revision: 0, executionId: '',
    run: runs.find(r => r.job_id === id)!, state: {}, cases: [], results: {},
    runningIds: [], retryingIds: [] } as RunProjection));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes('/cancel')) {
      cancelled.push(url.replace(/^.*\/nlq-eval\//, ''));
      body = { ok: true, cancelled: 3 };
    } else if (url.includes('/runs')) body = { runs };
    else if (url.includes('/suites')) body = { suites: [] };
    else if (url.includes('/status/')) body = { status: 'finished', total: 1, completed: 1 };
    else if (url.includes('/results/')) body = { run: runs[0], results: [], metrics: [], errors: [], state: {} };
    else if (url.includes('/summary/')) body = { headline_scores: [], categories: [] };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const view = render(
    <MemoryRouter initialEntries={['/results/bulk-cancel-0?tab=runner']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/results/:jobId" element={<NlqResultsPage />} /></Routes>
    </MemoryRouter>,
  );
  try {
    const cancel = await screen.findByRole('button', { name: 'Cancel all suites' });
    fireEvent.click(cancel);
    expect(await screen.findByText('Cancel all unfinished suites? Completed cases are kept.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    // One batch request: the server cancels every unfinished suite at once.
    await waitFor(() => expect(cancelled).toEqual(['batches/evaluation/cancel']));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Canceled 3 suites'));
    await act(async () => { await Promise.resolve(); });
  } finally {
    view.unmount();
    socket.restore();
    globalThis.fetch = original;
    success.mockRestore();
  }
});
}

test('pause all submits one backend batch command instead of coordinating suite ordering', async () => {
  const original = globalThis.fetch;
  const success = spyOn(message, 'success').mockImplementation(() => {});
  const paused: string[] = [];
  // Running comes first in launch order, as with Evaluate all.
  const runs = ['started', 'queued', 'queued', 'finished', 'paused'].map((status, i) => ({
    job_id: `bulk-pause-${i}`, status, batch_id: 'evaluation', suite_id: 'calcs-public',
    suite_label: `Suite ${i}`, runner_name: 'ect-server', ai_feature: 'calc',
    total: 1, completed: status === 'finished' ? 1 : 0, config: { batch_id: 'evaluation' },
    created_at: `2026-10-20 00:00:0${i}`,
  }));
  const socket = mockObservationSocket(id => ({ jobId: id, revision: 0, executionId: '',
    run: runs.find(r => r.job_id === id)!, state: {}, cases: [], results: {},
    runningIds: [], retryingIds: [] } as RunProjection));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes('/batches/evaluation/pause')) {
      paused.push('evaluation');
      body = { ok: true, paused: 3 };
    } else if (url.includes('/runs')) body = { runs };
    else if (url.includes('/suites')) body = { suites: [] };
    else if (url.includes('/status/')) body = { status: 'finished', total: 1, completed: 1 };
    else if (url.includes('/results/')) body = { run: runs[3], results: [], metrics: [], errors: [], state: {} };
    else if (url.includes('/summary/')) body = { headline_scores: [], categories: [] };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const view = render(
    <MemoryRouter initialEntries={['/results/bulk-pause-3?tab=runner']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/results/:jobId" element={<NlqResultsPage />} /></Routes>
    </MemoryRouter>,
  );
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Pause all suites' }));
    await waitFor(() => expect(paused).toHaveLength(1));
    expect(paused).toEqual(['evaluation']);
    await act(async () => { await Promise.resolve(); });
  } finally {
    view.unmount();
    socket.restore();
    globalThis.fetch = original;
    success.mockRestore();
  }
});

test('the Columns button hides a column and moves one; the choice is kept in the browser', async () => {
  const original = globalThis.fetch;
  localStorage.removeItem('ai_eval_results_columns');
  const run = {
    job_id: 'columns-run', status: 'finished', suite_id: 'calcs-public', suite_label: 'Columns suite',
    runner_name: 'ect-server', ai_feature: 'calc', total: 2, completed: 2, config: {}, created_at: '2026-10-29 00:00:00',
  };
  const socket = mockObservationSocket(id => ({ jobId: id, revision: 0, executionId: '', run, state: {},
    cases: [0, 1].map(i => ({ test_case_id: `${id}-case-${i}`, runner: 'ect-server', datasource: '', utterance: `Request ${i + 1}`, expected: {} })),
    results: {}, runningIds: [], retryingIds: [] } as RunProjection));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes('/runs')) body = { runs: [run] };
    else if (url.includes('/suites')) body = { suites: [] };
    else if (url.includes('/summary/')) body = { headline_scores: [], categories: [] };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const headers = () => screen.getAllByRole('columnheader').map(h => h.textContent);
  const view = render(
    <MemoryRouter initialEntries={['/results/columns-run?tab=runner']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/results/:jobId" element={<NlqResultsPage />} /></Routes>
    </MemoryRouter>,
  );
  try {
    await screen.findByRole('columnheader', { name: 'Expected response' });
    expect(headers().slice(0, 4)).toEqual(['Row', 'User request', 'Expected response', 'Actual response']);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Expected response' }));
    expect(screen.queryByRole('columnheader', { name: 'Expected response' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move User request up' }));
    expect(headers().slice(0, 3)).toEqual(['User request', 'Row', 'Actual response']);
    expect(JSON.parse(localStorage.getItem('ai_eval_results_columns') || '{}')).toEqual({
      order: ['utterance', 'index', 'expected', 'actual'], hidden: ['expected'],
    });
    expect((screen.getByRole('checkbox', { name: 'Row' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Columns' }));
    expect(headers().slice(0, 3)).toEqual(['Row', 'User request', 'Expected response']);
    expect(localStorage.getItem('ai_eval_results_columns')).toBeNull();
  } finally {
    view.unmount();
    socket.restore();
    globalThis.fetch = original;
    localStorage.removeItem('ai_eval_results_columns');
  }
});
