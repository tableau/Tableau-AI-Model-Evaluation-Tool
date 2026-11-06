/**
 * The connection drawer (Evaluation Setup, step 1) shows the connection form
 * and the evaluated model. The Saved Connections list was taken out of the
 * drawer on 2026-10-13; the drawer must not show it.
 */

import React from 'react';
// Testing-library with a DOM for bun test.
import { act, fireEvent, render, screen } from './testing.cjs';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { TourProvider } from './tour/TourContext';

const json = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

const mockServer = () => {
  (global as any).fetch = jest.fn((url: string) => {
    if (url.includes('/settings/tableau')) {
      return json({
        configured: true, server_url: 'https://tab.example.com', site: 'dev', pat_name: 'p', pat_value: '****',
        last_verified: { ok: true, at: new Date().toISOString(), failed_stage: null, model_under_test: 'gpt-4.1', connection_ok: true },
        saved_connections: [
          { server_url: 'https://tab.example.com', site: 'dev', pat_name: 'p', active: true },
          { server_url: 'https://other.example.com', site: '', pat_name: 'q', active: false },
        ],
      });
    }
    if (url.includes('/settings/judge')) return json({ configured: false });
    if (url.includes('/settings/content')) return json({ pinned_runs: [] });
    if (url.includes('/version')) return json({ version: 'x', commit: 'abc', data_dir: '/data' });
    if (url.includes('/suites')) return json({ suites: [], server_too_old: null });
    if (url.includes('/runs')) return json({ runs: [] });
    return json({});
  });
};

// Long enough for the Tableau UI library's expand/collapse animation (its
// Disclosure's transition runs 200ms) to finish inside act(); a shorter wait
// lets the transition's timer update state after act() returns, which React
// reports as "An update to Transition ... was not wrapped in act(...)".
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 250)); });

const openDrawer = async () => {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <TourProvider autoOpen={false}><Dashboard /></TourProvider>
    </MemoryRouter>,
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  await settle();
};

beforeEach(() => {
  window.localStorage.setItem('ai_eval_tour_seen', '1');
});

describe('the connection drawer', () => {
  it('fills the server and site when a Tableau view URL is pasted', async () => {
    mockServer();
    await openDrawer();
    const server = screen.getByPlaceholderText('https://my-server') as HTMLInputElement;
    const site = screen.getByPlaceholderText('Leave blank for the default site') as HTMLInputElement;
    const allowed = fireEvent.paste(server, {
      clipboardData: { getData: () => 'https://tableau.example.com/#/site/Evaluation/views/SampleWorkbook/SampleDashboard' },
    });
    expect(allowed).toBe(false);
    expect(server.value).toBe('https://tableau.example.com');
    expect(site.value).toBe('Evaluation');

    fireEvent.paste(server, { clipboardData: { getData: () => 'https://other.example/' } });
    expect(server.value).toBe('https://other.example');
    expect(site.value).toBe('Evaluation');

    fireEvent.paste(server, { clipboardData: { getData: () => 'https://other.example/#/views/Book/View' } });
    expect(server.value).toBe('https://other.example');
    expect(site.value).toBe('');
  });

  it('keeps normal typing and invalid pastes unchanged', async () => {
    mockServer();
    await openDrawer();
    const server = screen.getByPlaceholderText('https://my-server') as HTMLInputElement;
    const site = screen.getByPlaceholderText('Leave blank for the default site') as HTMLInputElement;
    fireEvent.change(server, { target: { value: 'https://typed.example' } });
    expect(server.value).toBe('https://typed.example');
    expect(site.value).toBe('dev');
    expect(fireEvent.paste(server, { clipboardData: { getData: () => 'not a URL' } })).toBe(true);
    expect(server.value).toBe('https://typed.example');
    expect(site.value).toBe('dev');
  });

  it('opens on the connection form, the evaluated model and nothing else', async () => {
    mockServer();
    await openDrawer();
    expect(screen.getByText('Tableau Server Connection')).toBeTruthy();
    expect(screen.getByText('Test and Save Connection')).toBeTruthy();
    expect(screen.getByText('Evaluated Model')).toBeTruthy();
    expect(screen.queryByText('Saved Connections')).toBeNull();
    expect(screen.queryByText('Forget')).toBeNull();
    expect(screen.queryByText(/settings and results in/)).toBeNull();
  });
});

describe('the stored last test', () => {
  it('says connected, and lists the site settings and the AI endpoint separately', async () => {
    // Reached and signed in, Tableau Agent in Authoring off, AI gateway 500
    // (Eval-Testing on 2026-11-04). The tag is about the connection alone;
    // what the site keeps the suites from doing is said in its own lines.
    const gateway = "The site's LLM gateway returned an error (500), not your connection to Tableau Server.";
    (global as any).fetch = jest.fn((url: string) => {
      if (url.includes('/settings/tableau')) {
        return json({
          configured: true, server_url: 'https://tab.example.com', site: 'dev', pat_name: 'p', pat_value: '****',
          last_verified: {
            ok: false, at: new Date().toISOString(), failed_stage: 'generations', model_under_test: 'claude-sonnet-5',
            connection_ok: true, server_too_old: null,
            dashboard_qa: { enabled: true, message: 'Tableau Agent in Dashboards is turned on for this site' },
            web_authoring: { enabled: false, reason: 'site_setting_off', message: 'Tableau Agent in Authoring is turned off for this site.' },
            generations: { ok: false, reason: 'gateway_error', message: gateway },
          },
          saved_connections: [],
        });
      }
      if (url.includes('/settings/judge')) return json({ configured: false });
      if (url.includes('/settings/content')) return json({ pinned_runs: [] });
      if (url.includes('/version')) return json({ version: 'x', commit: 'abc', data_dir: '/data' });
      if (url.includes('/suites')) return json({ suites: [], server_too_old: null });
      if (url.includes('/runs')) return json({ runs: [] });
      return json({});
    });
    await openDrawer();
    expect(screen.getByText('Last test: connected')).toBeTruthy();
    expect(screen.queryByText(/AI endpoint off/)).toBeNull();
    expect(screen.getByText(/Tableau Agent in Authoring is off, so Build a visualization, Calculated fields and Color palettes can't run/)).toBeTruthy();
    expect(screen.queryByText(/Tableau Agent in Dashboards is off/)).toBeNull();
    expect(screen.getByText(/The site's AI endpoint failed its test: The site's LLM gateway returned an error/)).toBeTruthy();
  });
});
