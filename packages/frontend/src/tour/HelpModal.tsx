/**
 * The help dialog: what the tool does, the three ideas an admin needs to
 * read its numbers, and the list of guided tours. Both lists are plain data
 * in tourConfig.ts (HELP_CONCEPTS, TOUR_FLOWS); each tour's card starts that
 * tour.
 *
 * It opens by itself on a first visit and from the header's "Take a tour"
 * button afterwards.
 */

import React, { useEffect, useState } from 'react';
import { Button, Modal } from '../ui';
import { CaretRightOutlined } from '../ui/icons';
import { fetchVisibleRuns } from '../runVisibility';
import { useTour } from './TourContext';
import { HELP_CONCEPTS, HELP_INTRO, HELP_TITLE, TOUR_FLOWS } from './tourConfig';
import './tour.css';

/** The run a tour of the results page opens: the latest finished one with
 *  results, else the latest with any results (a paused run has its scores). */
const pickResultsRun = (runs: any[]): string | null => {
  const withResults = runs.filter((r) => (r.completed || 0) > 0);
  const run = withResults.find((r) => r.status === 'finished') || withResults[0];
  return run ? run.job_id : null;
};

export const HelpModal: React.FC = () => {
  const { helpOpen, closeHelp, start } = useTour();
  // undefined while the run list is loading, null when no run has results.
  const [resultsJobId, setResultsJobId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!helpOpen) return undefined;
    let current = true;
    setResultsJobId(undefined);
    fetchVisibleRuns()
      .then((runs) => { if (current) setResultsJobId(pickResultsRun(runs)); })
      .catch(() => { if (current) setResultsJobId(null); });
    return () => { current = false; };
  }, [helpOpen]);

  return (
    <Modal
      open={helpOpen}
      title={
        <span className="tour-help-title">
          <img src="/logo192.png" alt="" />
          <span>{HELP_TITLE}</span>
        </span>
      }
      width={960}
      onCancel={closeHelp}
      footer={<Button onClick={closeHelp}>Close</Button>}
    >
      <p className="tour-help-intro">{HELP_INTRO}</p>
      <div className="tour-help-columns">
        <div className="tour-help-column">
          <h3 className="tour-help-heading">How it works</h3>
          <dl className="tour-help-concepts">
            {HELP_CONCEPTS.map((concept) => (
              <div key={concept.id}>
                <dt>{concept.title}</dt>
                <dd>{concept.description}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="tour-help-column">
          <h3 className="tour-help-heading">Take a tour</h3>
          <ul className="tour-help-topics">
            {TOUR_FLOWS.map((flow, index) => {
              // A tour of the results page needs an evaluation to open.
              const unavailable = flow.page === 'results' && !resultsJobId;
              return (
                <li key={flow.id}>
                  <button
                    type="button"
                    className="tour-help-topic"
                    disabled={unavailable}
                    aria-label={`${flow.title}: start the tour`}
                    onClick={() => start(flow.id, { resultsJobId: resultsJobId || undefined })}
                  >
                    <span className="tour-help-topic-index" aria-hidden="true">{index + 1}</span>
                    <span className="tour-help-topic-text">
                      <span className="tour-help-topic-title">{flow.title}</span>
                      <span className="tour-help-topic-description">
                        {unavailable && resultsJobId === null
                          ? 'Available once an evaluation has results.'
                          : flow.description}
                      </span>
                    </span>
                    <span className="tour-help-topic-play"><CaretRightOutlined /></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Modal>
  );
};
