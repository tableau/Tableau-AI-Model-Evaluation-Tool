import React from 'react';
import { act, fireEvent, render, screen } from './testing.cjs';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { TourProvider } from './tour/TourContext';

describe('evaluation history filters', () => {
  it('uses matching column layouts and bottom alignment for both dropdowns', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/runs') ? {
        filtered: true,
        runs: [{
          job_id: 'history-run', runner_name: 'nlq', ai_feature: 'viz',
          status: 'finished', total: 1, completed: 1, error: null,
          created_at: '2026-10-21T10:00:00Z',
        }],
      } : url.includes('/suites') ? { suites: [] } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as typeof fetch;
    try {
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <TourProvider autoOpen={false}><Dashboard /></TourProvider>
        </MemoryRouter>,
      );
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
      fireEvent.click(screen.getByRole('tab', { name: 'Evaluation History' }));
      const feature = screen.getByRole('combobox', { name: 'Filter by feature or capability' });
      const status = screen.getByRole('combobox', { name: 'Filter by status' });
      const featureLabel = feature.closest('.tui-select-wrap')?.parentElement;
      const statusLabel = status.closest('.tui-select-wrap')?.parentElement;
      for (const label of [featureLabel, statusLabel]) {
        expect(label?.tagName).toBe('LABEL');
        expect((label as HTMLElement).style.display).toBe('flex');
        expect((label as HTMLElement).style.flexDirection).toBe('column');
      }
      expect(featureLabel?.parentElement).toBe(statusLabel?.parentElement);
      expect(featureLabel?.parentElement?.style.alignItems).toBe('flex-end');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
