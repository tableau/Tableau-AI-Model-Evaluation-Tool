/**
 * The evaluator model drawer (Evaluation Setup, step 2): the evaluated
 * model's family comes from the connection test, not from a dropdown, and
 * picking an evaluator from that family warns before Save (bug bash
 * 2026-10-23, items 5 and 6).
 */
import React from 'react';
import { act, fireEvent, render, screen } from './testing.cjs';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { TourProvider } from './tour/TourContext';

const json = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 250)); });

test('the drawer names the evaluated model family and warns as a same-family provider is picked', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    if (url.includes('/settings/tableau')) {
      return json({
        configured: true, server_url: 'https://tab.example.com', site: 'dev', pat_name: 'p', pat_value: '****',
        last_verified: { ok: true, at: new Date().toISOString(), failed_stage: null, connection_ok: true },
      });
    }
    if (url.includes('/settings/judge')) {
      return json({ configured: true, provider: 'openai', model: 'gpt-4.1', api_key: '****', evaluated_model_family: 'anthropic', same_family_warning: false });
    }
    if (url.includes('/suites')) return json({ suites: [], server_too_old: null });
    if (url.includes('/runs')) return json({ runs: [] });
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
    // Step 1 and step 2 both say Change; the second is the evaluator model.
    fireEvent.click(screen.getAllByRole('button', { name: 'Change' })[1]!);
    await settle();
    expect(screen.getByText('Anthropic (from the connection test)')).toBeTruthy();
    expect(screen.queryByText(/Evaluated model family/)).toBeNull();
    expect(screen.queryByText(/shares a family/)).toBeNull();
    // The form's labels are not wired to their controls; the drawer's first
    // select is the provider.
    const provider = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: 'anthropic' } });
    await settle();
    expect(screen.getByText("This provider is the evaluated model's family")).toBeTruthy();
    view.unmount();
  } finally {
    globalThis.fetch = original;
  }
});
