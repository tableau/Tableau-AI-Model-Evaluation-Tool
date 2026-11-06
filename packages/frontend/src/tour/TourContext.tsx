/**
 * The guided tour's state, shared by the pieces that take part in it: the
 * header button and the help dialog start a tour, the overlay draws the
 * current step, and the home page reads the step's scene to show what the
 * step points at.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { TOUR_FLOWS, TourFlow, TourScene, TourStep } from './tourConfig';

interface ActiveTour {
  flowId: string;
  stepIndex: number;
  /** The page the tour runs on (a results tour names the run it opens). */
  route: string;
}

interface TourContextValue {
  flow: TourFlow | null;
  steps: TourStep[];
  stepIndex: number | null;
  currentStep: TourStep | null;
  isActive: boolean;
  /** The page the active tour runs on. */
  route: string | null;
  /** What the home page should be showing for the current step. */
  scene: TourScene | null;
  /** Starts a tour. A tour of a results page needs the run to open. */
  start: (flowId: string, opts?: { resultsJobId?: string }) => void;
  next: () => void;
  prev: () => void;
  exit: () => void;
  helpOpen: boolean;
  openHelp: () => void;
  closeHelp: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

/** Set once the help dialog has been seen, so it opens by itself only on the
 *  first visit in a browser. */
const SEEN_KEY = 'ai_eval_tour_seen';

const readSeen = (): boolean => {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // No storage (private mode): do not open by itself on every load.
    return true;
  }
};

const markSeen = () => {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* the dialog still works, it just is not remembered */
  }
};

export const TourProvider: React.FC<{
  /** Open the help dialog by itself on a first visit (the home page only). */
  autoOpen?: boolean;
  children: React.ReactNode;
}> = ({ autoOpen = false, children }) => {
  const [active, setActive] = useState<ActiveTour | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (autoOpen && !readSeen()) setHelpOpen(true);
    // First load only: arriving on the home page later is not a first visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback((flowId: string, opts?: { resultsJobId?: string }) => {
    const flow = TOUR_FLOWS.find((f) => f.id === flowId);
    if (!flow) return;
    if (flow.page === 'results' && !opts?.resultsJobId) return;
    markSeen();
    setHelpOpen(false);
    setActive({
      flowId,
      stepIndex: 0,
      route: flow.page === 'results' ? `/results/${opts!.resultsJobId}` : '/',
    });
  }, []);

  const next = useCallback(() => {
    setActive((a) => {
      if (!a) return a;
      const flow = TOUR_FLOWS.find((f) => f.id === a.flowId);
      if (!flow) return a;
      return a.stepIndex + 1 < flow.steps.length ? { ...a, stepIndex: a.stepIndex + 1 } : a;
    });
  }, []);

  const prev = useCallback(() => {
    setActive((a) => (a ? { ...a, stepIndex: Math.max(0, a.stepIndex - 1) } : a));
  }, []);

  const exit = useCallback(() => setActive(null), []);

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => {
    markSeen();
    setHelpOpen(false);
  }, []);

  const value = useMemo<TourContextValue>(() => {
    const flow = active ? TOUR_FLOWS.find((f) => f.id === active.flowId) ?? null : null;
    const steps = flow?.steps ?? [];
    const stepIndex = flow ? active!.stepIndex : null;
    const currentStep = flow && stepIndex !== null ? steps[stepIndex] ?? null : null;
    return {
      flow,
      steps,
      stepIndex,
      currentStep,
      isActive: currentStep !== null,
      route: currentStep ? active!.route : null,
      scene: currentStep?.scene ?? null,
      start,
      next,
      prev,
      exit,
      helpOpen,
      openHelp,
      closeHelp,
    };
  }, [active, helpOpen, start, next, prev, exit, openHelp, closeHelp]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
};

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within a TourProvider');
  return ctx;
}
