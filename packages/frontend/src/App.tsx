import React from 'react';
import { BrowserRouter as Router, Link, Route, Routes, useLocation } from 'react-router-dom';

// The logos are served from public/ (not imported) so they get stable,
// unhashed URLs. Bun's HTMLBundle (compiled binary) does not re-serve a
// Vite-hashed imported asset, so importing one broke the header logo in
// `bun release`. The tool's own logo is the icon the browser tab shows.
const tableauLogo = '/tableau-logo.png';
const toolLogo = '/logo192.png';
import { Button } from './ui';
import { QuestionCircleOutlined } from './ui/icons';
import { TDS } from './ui/tokens';
// The legacy multi-model comparison console (TestCaseEvaluation) was retired
// with its /evaluate-* backend in the 264 single-process refactor; the 264
// surface is the Dashboard + the results pages.
import Dashboard from './Dashboard';
import NlqResultsPage from './NlqResultsPage';
import { HelpModal } from './tour/HelpModal';
import { TourProvider, useTour } from './tour/TourContext';
import { TourOverlay } from './tour/TourOverlay';
import { TOUR_TARGETS } from './tour/tourConfig';

/** Opens the help dialog: what the tool does, and the guided tours. */
const HelpButton: React.FC = () => {
  const { openHelp } = useTour();
  return (
    <Button type="text" icon={<QuestionCircleOutlined />} data-tour={TOUR_TARGETS.helpButton} onClick={openHelp}>
      Take a Tour
    </Button>
  );
};

/** Page chrome: a product header in the Tableau idiom: the tool's logo and
 *  name at the left, the Tableau mark at the right end (decision of 2026-10-29).
 *  Settings are edited in place on the home page — the connection and the
 *  judge each open from their Evaluation Setup step — so the header carries no
 *  settings button (UX review 2026-09-24: on a results page it navigated
 *  away instead of opening anything). Its one button opens the guided tour. */
const Shell: React.FC = () => (
  <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: TDS.surface }}>
    <header
      style={{
        height: 56,
        padding: '0 24px',
        background: TDS.surface,
        borderBottom: `1px solid ${TDS.borderSubtle}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      <Link
        to="/"
        aria-label="Go to the home page"
        style={{ display: 'flex', alignItems: 'center', gap: 12, color: TDS.font, textDecoration: 'none' }}
      >
        <img src={toolLogo} alt="" style={{ height: 32, display: 'block' }} />
        <span className="tds-h2">Tableau AI Model Evaluation Tool</span>
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <HelpButton />
        <span aria-hidden style={{ width: 1, height: 24, background: TDS.borderSubtle }} />
        <img src={tableauLogo} alt="Tableau from Salesforce" style={{ height: 24, display: 'block' }} />
      </div>
    </header>
    <main style={{ padding: '24px 32px', flex: 1 }}>
      <Routes>
        {/* A feature's latest results: one tab per capability. */}
        <Route path="/results/feature/:feature" element={<NlqResultsPage />} />
        <Route path="/results/:jobId" element={<NlqResultsPage />} />
        <Route path="*" element={<Dashboard />} />
      </Routes>
    </main>
  </div>
);

/** The tour's state around the pages, and its two overlays beside them. The
 *  help dialog opens by itself on a first visit to the home page; a first
 *  visit that lands on a results link is left alone. */
const Tour: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { pathname } = useLocation();
  return (
    <TourProvider autoOpen={!pathname.startsWith('/results')}>
      {children}
      <HelpModal />
      <TourOverlay />
    </TourProvider>
  );
};

const App: React.FC = () => (
  <Router>
    <Tour>
      <Shell />
    </Tour>
  </Router>
);

export default App;
