/**
 * The guided tour: its state (start, next, back, exit), the overlay's card
 * and keys, and a guard on the content. The guard reads the pages' source:
 * a step whose element lost its `data-tour` name would still run, with its
 * card in the middle of the window and nothing lit, so a missing name fails
 * here instead.
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
// Testing-library with a DOM for bun test.
import { act, fireEvent, render, screen } from '../testing.cjs';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { TourProvider, useTour } from './TourContext';
import { TourOverlay } from './TourOverlay';
import { TOUR_FLOWS, TOUR_TARGETS } from './tourConfig';
import { OVERLAY_OPEN_EVENT } from '../ui';

const SETUP = TOUR_FLOWS.find((f) => f.id === 'setup')!;

/** Starts tours from a test and shows where the router is. */
const Harness: React.FC = () => {
  const tour = useTour();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/results/feature/viz')}>leave the page</button>
      <button type="button" onClick={() => tour.start('setup')}>start setup</button>
      <button type="button" onClick={() => tour.start('results', { resultsJobId: 'abc123' })}>start results</button>
      <button type="button" onClick={() => tour.start('results')}>start results without a run</button>
      <button type="button" onClick={() => tour.start('no-such-tour')}>start unknown</button>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="scene">{JSON.stringify(tour.scene)}</span>
      <span data-testid="help">{tour.helpOpen ? 'open' : 'closed'}</span>
      {/* The elements the setup tour points at. The results tour's are left
          out, to stand for a step whose element never appears. */}
      {SETUP.steps.map((s) => (
        <div key={s.id} data-tour={s.target}>
          {s.id}
          <button type="button">{`inside ${s.id}`}</button>
        </div>
      ))}
      <TourOverlay />
    </>
  );
};

const renderTour = (opts: { autoOpen?: boolean; at?: string } = {}) =>
  render(
    <MemoryRouter initialEntries={[opts.at ?? '/']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <TourProvider autoOpen={opts.autoOpen}>
        <Harness />
      </TourProvider>
    </MemoryRouter>,
  );

// Where the keyboard is: the thing under test, and only the document knows it.
// eslint-disable-next-line testing-library/no-node-access
const focusedElement = () => document.activeElement;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const text = (id: string) => screen.getByTestId(id).textContent;

/** Where the test says an element sits in the window (jsdom lays nothing out). */
let targetBox = { top: 100, bottom: 200, left: 100, right: 400, width: 300, height: 100 };
let scrollBy: jest.Mock;

beforeEach(() => {
  window.localStorage.clear();
  targetBox = { top: 100, bottom: 200, left: 100, right: 400, width: 300, height: 100 };
  Element.prototype.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
  Element.prototype.getBoundingClientRect = () => ({ ...targetBox, x: targetBox.left, y: targetBox.top, toJSON: () => ({}) });
  scrollBy = jest.fn();
  window.scrollBy = scrollBy;
});

describe('the tour', () => {
  it('shows nothing until a tour starts', () => {
    renderTour();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(text('scene')).toBe('null');
  });

  it('starts on the first step, with that step\'s scene', () => {
    renderTour();
    click('start setup');
    expect(screen.getByRole('dialog').textContent).toContain(`Step 1 of ${SETUP.steps.length}`);
    expect(screen.getByRole('dialog').textContent).toContain(SETUP.steps[0].title);
    expect(text('scene')).toBe(JSON.stringify(SETUP.steps[0].scene));
  });

  it('ignores a tour it does not know, and a results tour with no run to open', () => {
    renderTour();
    click('start unknown');
    click('start results without a run');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves with Next and Back, and Back is off on the first step', () => {
    renderTour();
    click('start setup');
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    click('Next');
    expect(screen.getByRole('dialog').textContent).toContain(SETUP.steps[1].title);
    click('Back');
    expect(screen.getByRole('dialog').textContent).toContain(SETUP.steps[0].title);
  });

  it('ends on Done at the last step', () => {
    renderTour();
    click('start setup');
    for (let i = 1; i < SETUP.steps.length; i += 1) click('Next');
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    click('Done');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(text('scene')).toBe('null');
  });

  it('ends from its close button and on Escape', () => {
    renderTour();
    click('start setup');
    click('End the tour');
    expect(screen.queryByRole('dialog')).toBeNull();
    click('start setup');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves with the arrow keys', () => {
    renderTour();
    click('start setup');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog').textContent).toContain(SETUP.steps[1].title);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog').textContent).toContain(SETUP.steps[0].title);
  });

  it('covers the page around the lit element and leaves the element itself open', () => {
    renderTour();
    click('start setup');
    // Four panels around the element, not one over everything.
    const panels = screen.getAllByRole('presentation');
    expect(panels.length).toBe(4);
    expect(panels.filter((p) => p.className.includes('tour-blocker-dim'))).toEqual([]);
  });

  it('offers something to try on steps that have it', () => {
    renderTour();
    click('start setup');
    expect(screen.getByRole('dialog').textContent).not.toContain('Try it:');
    click('Next');
    expect(screen.getByRole('dialog').textContent).toContain(`Try it: ${SETUP.steps[1].tryIt}`);
  });

  it('takes Tab from the card into the lit element and back, never to the page behind', () => {
    renderTour();
    click('start setup');
    const inside = screen.getByRole('button', { name: `inside ${SETUP.steps[0].id}` });
    expect(focusedElement()).toBe(screen.getByRole('button', { name: 'Next' }));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(focusedElement()).toBe(inside);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(focusedElement()).toBe(screen.getByRole('button', { name: 'End the tour' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(focusedElement()).toBe(inside);
  });

  it('ends when the admin opens a form from the lit element', () => {
    renderTour();
    click('start setup');
    act(() => { document.dispatchEvent(new Event(OVERLAY_OPEN_EVENT)); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ends when the admin leaves the page, and does not pull them back', () => {
    renderTour();
    click('start setup');
    click('leave the page');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(text('path')).toBe('/results/feature/viz');
  });

  it('keeps Escape for a menu the lit element opened, then ends on the next one', () => {
    renderTour();
    click('start setup');
    const menu = document.createElement('div');
    menu.className = 'tui-popover';
    document.body.appendChild(menu);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    menu.remove();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('goes to the page a tour runs on', () => {
    renderTour({ at: '/results/feature/viz' });
    click('start setup');
    expect(text('path')).toBe('/');
    click('End the tour');
    click('start results');
    expect(text('path')).toBe('/results/abc123');
  });

  it('leaves the page where it is when the element is in view with room for the card', () => {
    renderTour();
    click('start setup');
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('scrolls an element below the fold into view', () => {
    targetBox = { ...targetBox, top: 2000, bottom: 2100 };
    renderTour();
    click('start setup');
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0][0].top).toBeGreaterThan(1000);
  });

  it('scrolls an element that is in view but leaves no room for the card', () => {
    // Fills the window's width, with its bottom edge near the window's.
    targetBox = { top: 100, bottom: window.innerHeight - 40, left: 0, right: window.innerWidth, width: window.innerWidth, height: window.innerHeight - 140 };
    renderTour();
    click('start setup');
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it('shows a step\'s card even when its element never appears', () => {
    jest.useFakeTimers();
    try {
      renderTour();
      click('start results');
      expect(screen.queryByRole('dialog')).toBeNull();
      act(() => { jest.advanceTimersByTime(6000); });
      expect(screen.getByRole('dialog').textContent).toContain('Step 1 of');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the help dialog', () => {
  it('opens by itself on a first visit only', () => {
    const view = renderTour({ autoOpen: true });
    expect(text('help')).toBe('open');
    // Starting a tour (or closing the dialog) counts as having seen it.
    click('start setup');
    expect(text('help')).toBe('closed');
    view.unmount();
    renderTour({ autoOpen: true });
    expect(text('help')).toBe('closed');
  });

  it('stays closed where it is not asked to open', () => {
    renderTour({ autoOpen: false });
    expect(text('help')).toBe('closed');
  });
});

describe('the tour content', () => {
  const source = ['App.tsx', 'Dashboard.tsx', 'NlqResultsPage.tsx']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))
    .join('\n');

  it('points every step at an element a page names', () => {
    const names = Object.entries(TOUR_TARGETS) as Array<[string, string]>;
    for (const flow of TOUR_FLOWS) {
      for (const step of flow.steps) {
        const entry = names.find(([, id]) => id === step.target);
        expect(entry).toBeDefined();
        expect(source).toContain(`TOUR_TARGETS.${entry![0]}`);
      }
    }
  });

  it('gives every tour steps, and every step its own id, title and text', () => {
    for (const flow of TOUR_FLOWS) {
      expect(flow.steps.length).toBeGreaterThan(0);
      expect(new Set(flow.steps.map((s) => s.id)).size).toBe(flow.steps.length);
      for (const step of flow.steps) {
        expect(step.title).toBeTruthy();
        expect(step.description).toBeTruthy();
      }
    }
  });

  it('gives a scene only to steps on the home page, the one page that reads it', () => {
    const elsewhere = TOUR_FLOWS.filter((f) => f.page !== 'home').flatMap((f) => f.steps);
    expect(elsewhere.filter((s) => s.scene)).toEqual([]);
  });
});
