/**
 * The guided tour's overlay: it dims the page, leaves the current step's
 * element lit, and shows a card beside it with the step's text and the
 * Back / Next buttons. No tour library: the lit area is a box the size of
 * the element whose very large shadow darkens everything around it.
 *
 * The lit element is live: the admin can hover it, click it and tab into it,
 * to try what the step describes. The rest of the page is covered. A click
 * that opens a form or leaves the page ends the tour, since the admin has
 * started doing the thing itself.
 *
 * A step's element is found only by its `data-tour` attribute (tourConfig).
 * It may not be on the page yet when the step starts (the tour has just
 * opened a panel, or moved to the results page), so the overlay keeps
 * looking, and follows the element when the page scrolls or its layout
 * changes. A step whose element never shows up still gets its card, in the
 * middle of the window.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, OVERLAY_OPEN_EVENT } from '../ui';
import { CloseOutlined } from '../ui/icons';
import { useTour } from './TourContext';
import { TOUR_TARGETS, TourStep } from './tourConfig';
import './tour.css';

const TARGET_POLL_INTERVAL_MS = 100;
/** How long a step waits for its element before showing its card anyway. */
const TARGET_WAIT_MS = { home: 700, results: 5000 };
const SPOTLIGHT_PADDING = 6;
const CARD_WIDTH = 340;
const CARD_GAP = 14;
/** The height to keep free beside an element for its card and the gap. */
const CARD_ROOM = 270;
const VIEWPORT_MARGIN = 16;

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const findTarget = (step: TourStep): HTMLElement | null => {
  const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
  // An element inside a closed panel is in the page but takes no space.
  return el && el.getClientRects().length > 0 ? el : null;
};

const measure = (el: Element): TargetRect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

const sameRect = (a: TargetRect | null, b: TargetRect | null): boolean =>
  a === b ||
  (!!a && !!b &&
    Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Brings a step's element on screen with room for its card. An element that
 * is already in view with room beside it is left where it is, so the page
 * does not move under the admin for no reason. Otherwise the page scrolls so
 * the element and the card under it sit in the middle of the window; an
 * element taller than the window is put at the top.
 */
const reveal = (el: HTMLElement) => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let r = el.getBoundingClientRect();
  const sideRoom = CARD_WIDTH + CARD_GAP + SPOTLIGHT_PADDING + VIEWPORT_MARGIN;
  const inView = r.top >= VIEWPORT_MARGIN && r.bottom <= vh - VIEWPORT_MARGIN && r.left >= 0 && r.right <= vw;
  const roomForCard =
    vh - r.bottom >= CARD_ROOM || r.top >= CARD_ROOM || vw - r.right >= sideRoom || r.left >= sideRoom;
  if (inView && roomForCard) return;
  if (r.left < 0 || r.right > vw) {
    // Off to the side inside a table that scrolls sideways.
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    r = el.getBoundingClientRect();
  }
  const edge = VIEWPORT_MARGIN + SPOTLIGHT_PADDING;
  const top = r.height + CARD_ROOM + edge * 2 <= vh ? Math.max(edge, (vh - r.height - CARD_ROOM) / 2) : edge;
  if (Math.abs(r.top - top) < 1) return;
  window.scrollBy?.({ top: r.top - top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
};

/** The lit area: the element plus a margin, kept inside the window so a
 *  table taller than the window still has a visible edge. */
const spotlightOf = (rect: TargetRect): TargetRect => {
  const top = Math.max(rect.top - SPOTLIGHT_PADDING, 4);
  const left = Math.max(rect.left - SPOTLIGHT_PADDING, 4);
  const bottom = Math.min(rect.top + rect.height + SPOTLIGHT_PADDING, window.innerHeight - 4);
  const right = Math.min(rect.left + rect.width + SPOTLIGHT_PADDING, window.innerWidth - 4);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};

/** The part of the element inside the window: the hole in the cover over
 *  the page, through which the element is used. */
const holeOf = (rect: TargetRect): TargetRect => {
  const top = Math.max(rect.top, 0);
  const left = Math.max(rect.left, 0);
  const bottom = Math.min(rect.top + rect.height, window.innerHeight);
  const right = Math.min(rect.left + rect.width, window.innerWidth);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusableIn = (root: Element | null): HTMLElement[] =>
  root
    ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0)
    : [];

/** Where the card goes: under the lit area, else above it, else beside it,
 *  else in the window's bottom right corner (the element fills the window). */
const placeCard = (spot: TargetRect | null, cardHeight: number): { top: number; left: number } => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardWidth = Math.min(CARD_WIDTH, vw - VIEWPORT_MARGIN * 2);
  const clampLeft = (x: number) => Math.max(VIEWPORT_MARGIN, Math.min(x, vw - cardWidth - VIEWPORT_MARGIN));
  const clampTop = (y: number) => Math.max(VIEWPORT_MARGIN, Math.min(y, vh - cardHeight - VIEWPORT_MARGIN));
  if (!spot) return { top: clampTop((vh - cardHeight) / 2), left: clampLeft((vw - cardWidth) / 2) };
  const below = spot.top + spot.height + CARD_GAP;
  if (below + cardHeight <= vh - VIEWPORT_MARGIN) return { top: below, left: clampLeft(spot.left) };
  const above = spot.top - CARD_GAP - cardHeight;
  if (above >= VIEWPORT_MARGIN) return { top: above, left: clampLeft(spot.left) };
  const right = spot.left + spot.width + CARD_GAP;
  if (right + cardWidth <= vw - VIEWPORT_MARGIN) return { top: clampTop(spot.top), left: right };
  const left = spot.left - CARD_GAP - cardWidth;
  if (left >= VIEWPORT_MARGIN) return { top: clampTop(spot.top), left };
  return { top: clampTop(vh), left: clampLeft(vw) };
};

/** The tour's page, keeping the address's dev flag (the home page reads it
 *  when it loads). */
const withDevFlag = (route: string, search: string): string =>
  new URLSearchParams(search).has('dev') ? `${route}?dev=1` : route;

interface TourStepPanelProps {
  step: TourStep;
  waitMs: number;
  currentIndex: number;
  totalSteps: number;
  next: () => void;
  prev: () => void;
  exit: () => void;
}

// Keyed by step in TourOverlay, so each step starts with no rect of its own
// and the lit area never sits on the previous step's element while the page
// is still changing to show the new one.
const TourStepPanel: React.FC<TourStepPanelProps> = ({
  step, waitMs, currentIndex, totalSteps, next, prev, exit,
}) => {
  const [rect, setRect] = useState<TargetRect | null>(null);
  // The element did not show up in time: the card is shown without it.
  const [gaveUp, setGaveUp] = useState(false);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const revealedRef = useRef(false);

  useLayoutEffect(() => {
    const update = () => {
      const el = findTarget(step);
      if (el && !revealedRef.current) {
        revealedRef.current = true;
        reveal(el);
      }
      const found = el ? measure(el) : null;
      setRect((prevRect) => (sameRect(prevRect, found) ? prevRect : found));
    };
    update();
    const pollTimer = window.setInterval(update, TARGET_POLL_INTERVAL_MS);
    const waitTimer = window.setTimeout(() => setGaveUp(true), waitMs);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.clearInterval(pollTimer);
      window.clearTimeout(waitTimer);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [step, waitMs]);

  const spot = rect ? spotlightOf(rect) : null;
  const showCard = Boolean(rect) || gaveUp;

  useLayoutEffect(() => {
    if (!showCard) return;
    setCardPos(placeCard(spot, cardRef.current?.offsetHeight ?? 180));
    // `spot` is derived from `rect` on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, showCard]);

  // Enter moves the tour on: each step starts with its main button focused.
  const placed = showCard && cardPos !== null;
  useEffect(() => {
    if (placed) primaryRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A menu or confirmation opened from the lit element closes first;
        // the next Escape ends the tour.
        if (!document.querySelector('.tui-popover')) exit();
        return;
      }
      if (e.key !== 'Tab') return;
      // Tab goes round the card, the lit element and anything it has opened;
      // the covered page is not reachable.
      const stops = [
        ...focusableIn(cardRef.current),
        ...focusableIn(findTarget(step)),
        ...Array.from(document.querySelectorAll('.tui-popover')).flatMap(focusableIn),
      ];
      if (!stops.length) return;
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const to = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
      e.preventDefault();
      stops[to].focus();
    };
    // The admin opened a form from the lit element: the tour makes way.
    const onOverlay = () => exit();
    document.addEventListener('keydown', onKey);
    document.addEventListener(OVERLAY_OPEN_EVENT, onOverlay);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener(OVERLAY_OPEN_EVENT, onOverlay);
    };
  }, [exit, step]);

  // Tooltips, menus and messages the lit element brings up show above the dim.
  useEffect(() => {
    document.body.classList.add('tour-active');
    return () => document.body.classList.remove('tour-active');
  }, []);

  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalSteps - 1;

  // Only from the card, so the arrow keys still work inside the lit element.
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' && !isLast) next();
    if (e.key === 'ArrowLeft' && !isFirst) prev();
  };

  // The cover over the page: four panels around the element, so the element
  // itself takes the mouse. With no element to light, one panel covers it all.
  const hole = rect ? holeOf(rect) : null;

  return createPortal(
    <>
      {hole ? (
        <>
          <div className="tour-blocker" role="presentation" style={{ top: 0, left: 0, right: 0, height: hole.top }} />
          <div className="tour-blocker" role="presentation" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          <div className="tour-blocker" role="presentation" style={{ top: hole.top, left: 0, width: hole.left, height: hole.height }} />
          <div className="tour-blocker" role="presentation" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
        </>
      ) : (
        <div className="tour-blocker tour-blocker-dim" role="presentation" style={{ inset: 0 }} />
      )}
      {spot && (
        <div
          className="tour-spotlight"
          aria-hidden="true"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      )}
      {showCard && (
        <div
          ref={cardRef}
          className="tour-card"
          role="dialog"
          aria-label="Guided tour"
          aria-describedby="tour-step-description"
          tabIndex={-1}
          style={{
            top: cardPos?.top ?? -9999,
            left: cardPos?.left ?? -9999,
            visibility: cardPos ? 'visible' : 'hidden',
          }}
          onKeyDown={onCardKeyDown}
        >
          <div className="tour-card-head">
            <span className="tour-step-counter">Step {currentIndex + 1} of {totalSteps}</span>
            <button type="button" className="tui-close" aria-label="End the tour" onClick={exit}>
              <CloseOutlined />
            </button>
          </div>
          <h2 className="tour-card-title">{step.title}</h2>
          <p id="tour-step-description" className="tour-card-description">{step.description}</p>
          {step.tryIt && rect && (
            <p className="tour-card-try"><strong>Try it:</strong> {step.tryIt}</p>
          )}
          <div className="tour-card-actions">
            <Button size="small" onClick={prev} disabled={isFirst}>Back</Button>
            <Button ref={primaryRef} size="small" type="primary" onClick={isLast ? exit : next}>
              {isLast ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
};

export const TourOverlay: React.FC = () => {
  const { isActive, flow, currentStep, stepIndex, steps, route, next, prev, exit } = useTour();
  const location = useLocation();
  const navigate = useNavigate();

  // A tour first goes to the page it runs on. Once there, a change of page
  // is the admin's own doing (a link in the lit element): the tour ends
  // rather than pull them back.
  const reachedRoute = useRef<string | null>(null);
  useEffect(() => {
    if (!isActive || !route) {
      reachedRoute.current = null;
    } else if (location.pathname === route) {
      reachedRoute.current = route;
    } else if (reachedRoute.current === route) {
      exit();
    } else {
      navigate(withDevFlag(route, location.search));
    }
  }, [isActive, route, location.pathname, location.search, navigate, exit]);

  // When the tour ends from its card, the keyboard goes back to the button
  // that opens it. When it ends because the admin opened something, the
  // keyboard is already where they put it and stays there.
  const wasActive = useRef(false);
  useEffect(() => {
    const nowhere = !document.activeElement || document.activeElement === document.body;
    if (wasActive.current && !isActive && nowhere) {
      document.querySelector<HTMLElement>(`[data-tour="${TOUR_TARGETS.helpButton}"]`)?.focus();
    }
    wasActive.current = isActive;
  }, [isActive]);

  if (!isActive || !flow || !currentStep || !route) return null;

  return (
    <TourStepPanel
      key={`${flow.id}:${currentStep.id}`}
      step={currentStep}
      waitMs={TARGET_WAIT_MS[flow.page]}
      currentIndex={stepIndex ?? 0}
      totalSteps={steps.length}
      next={next}
      prev={prev}
      exit={exit}
    />
  );
};
