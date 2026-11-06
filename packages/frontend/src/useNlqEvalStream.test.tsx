import React from 'react';
import { expect, test } from 'bun:test';
import { act, fireEvent, render, screen, waitFor } from './testing.cjs';
import { RunObservationStore, useNlqEvalStream } from './useNlqEvalStream';
import type { RunProjection, RunChange } from '@tableau-ai-eval/run-state';
import { mockObservationSocket } from './testingWebSocket';

function snapshot(jobId: string, revision = 0): RunProjection {
  return { jobId, revision, executionId: 'execution-1',
    run: { job_id: jobId, status: 'started', total: 2, completed: 0, config: {} }, state: {},
    cases: ['a', 'b'].map(test_case_id => ({ test_case_id, runner: 'fake', datasource: null,
      utterance: test_case_id, expected: {} })), results: {}, runningIds: ['a'], retryingIds: [] };
}

test('shared store projects pause/resume/retry fixtures without network or timers', () => {
  const store = new RunObservationStore('fixture');
  store.ingest({ type: 'snapshot', projection: snapshot('fixture') });
  expect(store.getSnapshot().rows[0].running).toBe(true);
  const pause: RunChange = { type: 'change', jobId: 'fixture', revision: 1,
    executionId: 'revoked', run: { status: 'paused' } };
  store.ingest(pause);
  expect(store.getSnapshot().rows.every(r => !r.running)).toBe(true);
  expect(store.getSnapshot().rows).toHaveLength(2);
  store.ingest(pause); // duplicate delivery is harmless
  expect(store.getSnapshot().revision).toBe(1);
  expect(() => store.ingest({ ...pause, revision: 3 })).toThrow('revision gap');
  store.ingest({ type: 'snapshot', projection: { ...snapshot('fixture', 8),
    run: { ...snapshot('fixture').run, status: 'queued' }, runningIds: [] } });
  expect(store.getSnapshot().revision).toBe(8);
  expect(store.getSnapshot().run?.status).toBe('queued');
});

function Probe({ job }: { job: string }) {
  const { state, reload } = useNlqEvalStream(job);
  return <div><div>{state.run?.status || state.status}</div>
    {state.rows.map(r => <div key={r.key} data-testid={r.test_case_id}>
      {r.running ? 'Running' : r.pending ? 'Waiting' : 'Completed'}
    </div>)}<button onClick={reload}>Reload</button></div>;
}

test('pause arrives as one committed event; reload uses a current snapshot, not results/history', async () => {
  let current = snapshot('live');
  const mock = mockObservationSocket(() => current);
  const view = render(<Probe job="live" />);
  try {
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('Running'));
    await act(async () => {
      mock.sockets[0].change({ type: 'change', jobId: 'live',
        revision: 1, executionId: 'revoked', run: { status: 'paused' } });
    });
    expect(screen.getByText('paused')).toBeTruthy();
    expect(screen.getByTestId('a').textContent).toBe('Waiting');
    current = { ...current, revision: 5, runningIds: [], run: { ...current.run, status: 'queued' } };
    fireEvent.click(screen.getByText('Reload'));
    await waitFor(() => expect(screen.getByText('queued')).toBeTruthy());
    expect(mock.sockets.flatMap(s => s.commands).filter(c => c.type === 'subscribe')).toHaveLength(2);
  } finally {
    view.unmount();
    mock.restore();
  }
});

test('tab switches do not show the preceding run and late old events cannot overwrite the selected run', async () => {
  const mock = mockObservationSocket(id => ({ ...snapshot(id),
    run: { ...snapshot(id).run, status: id === 'tab-a' ? 'paused' : 'queued' }, runningIds: [] }));
  const view = render(<Probe job="tab-a" />);
  try {
    await screen.findByText('paused');
    view.rerender(<Probe job="tab-b" />);
    expect(screen.queryByText('paused')).toBeNull();
    await screen.findByText('queued');
  } finally {
    view.unmount(); mock.restore();
  }
});

test('a revision gap reconnects with a fresh snapshot instead of applying incomplete history', async () => {
  let requests = 0;
  const mock = mockObservationSocket(() => {
    requests += 1;
    const current = requests === 1 ? snapshot('gap') : { ...snapshot('gap', 10),
      run: { ...snapshot('gap').run, status: 'paused' as const }, runningIds: [] };
    return current;
  });
  const view = render(<Probe job="gap" />);
  try {
    await screen.findByText('started');
    await act(async () => {
      mock.sockets[0].change({ type: 'change', jobId: 'gap',
        revision: 3, executionId: 'old', run: { status: 'finished' } });
    });
    expect(screen.queryByText('finished')).toBeNull();
    await waitFor(() => expect(screen.getByText('paused')).toBeTruthy(), { timeout: 2500 });
    expect(requests).toBe(2);
  } finally {
    view.unmount(); mock.restore();
  }
});

test('many queued and paused stores share one socket; reload and late subscriptions stay isolated', async () => {
  const mock = mockObservationSocket(id => ({ ...snapshot(id),
    run: { ...snapshot(id).run, status: 'queued' }, runningIds: [] }));
  const stores = Array.from({ length: 12 }, (_, i) => new RunObservationStore(`multiplex-${i}`));
  const releases = stores.map(store => store.retain());
  try {
    await waitFor(() => expect(stores.every(s => s.getSnapshot().confirmed)).toBe(true));
    expect(mock.sockets).toHaveLength(1);
    const socket = mock.sockets[0];
    const oldId = socket.subscriptions.get(stores[0].jobId)!;
    stores[0].reload();
    socket.deliver(oldId, { type: 'change', jobId: stores[0].jobId, revision: 1,
      executionId: 'stale', run: { status: 'finished' } });
    await waitFor(() => expect(stores[0].getSnapshot().confirmed).toBe(true));
    expect(stores[0].getSnapshot().run?.status).toBe('queued');
    expect(mock.sockets).toHaveLength(1);
    releases[0]();
    socket.change({ type: 'change', jobId: stores[1].jobId, revision: 1,
      executionId: 'active', run: { status: 'started' } });
    expect(stores[1].getSnapshot().run?.status).toBe('started');
    socket.close();
    expect(stores[1].getSnapshot().connection).toBe('reconnecting');
    await waitFor(() => expect(mock.sockets).toHaveLength(2), { timeout: 2500 });
    await waitFor(() => expect(stores[1].getSnapshot().confirmed).toBe(true));
    expect(stores[1].getSnapshot().run?.status).toBe('started'); // stale snapshot cannot roll back revision
  } finally { releases.slice(1).forEach(release => release()); mock.restore(); }
});

test('a deliberate reload keeps the connection as it was; only a lost socket reads as reconnecting', async () => {
  const mock = mockObservationSocket(id => snapshot(id));
  const store = new RunObservationStore('reload-keeps-connection');
  const release = store.retain();
  try {
    await waitFor(() => expect(store.getSnapshot().confirmed).toBe(true));
    expect(store.getSnapshot().connection).toBe('connected');
    store.reload();
    expect(store.getSnapshot().confirmed).toBe(false);
    expect(store.getSnapshot().connection).toBe('connected');
    await waitFor(() => expect(store.getSnapshot().confirmed).toBe(true));
    mock.sockets[mock.sockets.length - 1].close();
    expect(store.getSnapshot().connection).toBe('reconnecting');
  } finally { release(); mock.restore(); }
});
