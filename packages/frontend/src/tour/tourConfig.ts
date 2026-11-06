/**
 * The guided tour's content: what the help dialog explains, and the tours it
 * offers. Each tour is one card in the dialog and runs its own steps from
 * start to finish. Change the wording, reorder steps or add a tour here; the
 * components (HelpModal, TourOverlay) only draw what this file lists.
 *
 * A step points at its element by a `data-tour="<id>"` attribute, never by a
 * CSS or structural selector, so the tour keeps working when the markup
 * around the element changes. Every id is declared once in TOUR_TARGETS and
 * the page puts the same constant on the element.
 */

import type { FeatureKey } from '../featureGroups';

export const TOUR_TARGETS = {
  helpButton: 'tour-help-button',
  setup: 'tour-setup',
  setupConnect: 'tour-setup-connect',
  setupJudge: 'tour-setup-judge',
  setupEvaluate: 'tour-setup-evaluate',
  features: 'tour-features',
  evaluateAll: 'tour-evaluate-all',
  capabilities: 'tour-capabilities',
  featureResults: 'tour-feature-results',
  history: 'tour-history',
  scoreLegend: 'tour-score-legend',
  rowActions: 'tour-row-actions',
  resultsHeader: 'tour-results-header',
  resultsTiles: 'tour-results-tiles',
  resultsScores: 'tour-results-scores',
  resultsTable: 'tour-results-table',
  resultsActions: 'tour-results-actions',
} as const;

export type TourTargetId = (typeof TOUR_TARGETS)[keyof typeof TOUR_TARGETS];

/** The feature card the home page tours open to show what is inside one. */
export const TOUR_FEATURE: FeatureKey = 'viz';

/**
 * What the home page has to be showing for a step's element to exist: the
 * setup panel open, one of the two tabs selected, a feature card open. The
 * home page reads the current step's scene and shows it for as long as the
 * step is up; nothing the admin chose is overwritten.
 */
export interface TourScene {
  setup?: boolean;
  tab?: 'features' | 'history';
  feature?: FeatureKey;
}

export interface TourStep {
  id: string;
  target: TourTargetId;
  title: string;
  description: string;
  /** Something to try on the element, which stays usable during its step. */
  tryIt?: string;
  scene?: TourScene;
}

export interface TourFlow {
  id: string;
  title: string;
  description: string;
  /** Where the tour runs: the home page, or the results page of an evaluation. */
  page: 'home' | 'results';
  steps: TourStep[];
}

export interface HelpConcept {
  id: string;
  title: string;
  description: string;
}

export const HELP_TITLE = 'Welcome to the Tableau AI Model Evaluation Tool';

export const HELP_INTRO =
  'This tool runs test suites against the AI model configured for your site and compares performance with the default model.';

/** Plain explainers shown beside the list of tours. */
export const HELP_CONCEPTS: HelpConcept[] = [
  {
    id: 'evaluatedModel',
    title: 'Evaluated model',
    description:
      'Evaluations run through Tableau Server using the model configured in AI in Tableau Site Settings. This tool reads your site settings without making changes.',
  },
  {
    id: 'suites',
    title: 'Features, capabilities, and test suites',
    description:
      'Each feature includes capabilities such as creating calculated fields or building visualizations. For each capability, there is a suite of test cases with requests and expected responses.',
  },
  {
    id: 'scores',
    title: 'Scores and baseline',
    description:
      'Answers are scored from 0 to 100%. Color indicators compare your results against the baseline score: green for at or above baseline, yellow for up to 25 points below, and red for lower scores.',
  },
];

export const TOUR_FLOWS: TourFlow[] = [
  {
    id: 'setup',
    title: 'Set up the Tool',
    description: 'Connect to Tableau Server and optionally select an evaluator model to score written responses.',
    page: 'home',
    steps: [
      {
        id: 'panel',
        target: TOUR_TARGETS.setup,
        title: 'Evaluation Setup',
        description:
          'Three steps take you from initial setup to your first evaluation result. Each card shows the status of that step.',
        scene: { setup: true },
      },
      {
        id: 'connect',
        target: TOUR_TARGETS.setupConnect,
        title: 'Connect to Tableau Server',
        description:
          'Enter your server address, site name and a personal access token. The tool tests the connection, saves it, and reads which model your site uses.',
        tryIt: 'Select the card\'s button to open the connection form. The tour ends here so you can fill it in.',
        scene: { setup: true },
      },
      {
        id: 'judge',
        target: TOUR_TARGETS.setupJudge,
        title: 'Add Evaluator Model (optional)',
        description:
          'Written answers are scored by a second model, the evaluator. Choose a model from a different family than the evaluated model. Formula and chart checks run without an evaluator model.',
        tryIt: 'Select Change on the card to open the evaluator model form. The tour ends here.',
        scene: { setup: true },
      },
      {
        id: 'evaluate',
        target: TOUR_TARGETS.setupEvaluate,
        title: 'Evaluate',
        description:
          'Shows which AI features have results so far. Evaluate All runs every feature\'s test suites, one evaluation per feature; the feature cards below run one feature or one capability.',
        scene: { setup: true },
      },
    ],
  },
  {
    id: 'evaluate',
    title: 'Select Features to Evaluate',
    description: 'Select a feature, evaluate capabilities, and monitor test progress.',
    page: 'home',
    steps: [
      {
        id: 'features',
        target: TOUR_TARGETS.features,
        title: 'One Card per AI Feature',
        description:
          'These are the features listed in Site Settings > AI in Tableau. Each card lists its capabilities; open it for its evaluations.',
        tryIt: 'Click a card to open it.',
        scene: { tab: 'features' },
      },
      {
        id: 'evaluateAll',
        target: TOUR_TARGETS.evaluateAll,
        title: 'Evaluate',
        description:
          'Runs every test suite for the feature, one after another, and starts at once. Evaluations continue in the background if you close this browser tab.',
        tryIt: 'Hover over Evaluate to see the suites it runs, their test case counts and about how long each takes. Selecting it starts the evaluation, so hover only for now.',
        scene: { tab: 'features' },
      },
      {
        id: 'capabilities',
        target: TOUR_TARGETS.capabilities,
        title: 'Capabilities',
        description:
          'Each one has its own test suite, and opens its latest results, where it can also be evaluated on its own.',
        tryIt: 'Hover over a capability for its number of tests and how long they take.',
        scene: { tab: 'features' },
      },
      {
        id: 'featureResults',
        target: TOUR_TARGETS.featureResults,
        title: 'Test Results',
        description:
          'Every evaluation of this feature: the model that was tested, when, its status and its scores. A run in progress can be paused, resumed, or canceled from its row.',
        tryIt: 'Hover over a status to see how far the run got, or over a score to see its baseline.',
        scene: { tab: 'features', feature: TOUR_FEATURE },
      },
    ],
  },
  {
    id: 'history',
    title: 'Track Evaluations',
    description: 'View evaluations in progress, paused, or completed, and review score history.',
    page: 'home',
    steps: [
      {
        id: 'history',
        target: TOUR_TARGETS.history,
        title: 'Evaluation History',
        description:
          'View every evaluation across all features in one list. Filter by feature, capability, or status to find specific results.',
        tryIt: 'Select a filter.',
        scene: { tab: 'history' },
      },
      {
        id: 'legend',
        target: TOUR_TARGETS.scoreLegend,
        title: 'Score Colors',
        description:
          'Green is at or above the baseline, yellow up to 25 points below it, red further below. The baseline is what the default Tableau model scored on the same suite.',
        scene: { tab: 'history' },
      },
      {
        id: 'rowActions',
        target: TOUR_TARGETS.rowActions,
        title: 'Open, Download, and Manage',
        description:
          'Select View Results to open an evaluation. Use the action icons to download results as a CSV file, pause, resume, cancel, or delete a run.',
        tryIt: 'Hover over an icon to view its function.',
        scene: { tab: 'history' },
      },
    ],
  },
  {
    id: 'results',
    title: 'Read Results',
    description: 'Open a completed evaluation to review detailed performance metrics.',
    page: 'results',
    steps: [
      {
        id: 'header',
        target: TOUR_TARGETS.resultsHeader,
        title: 'What Was Tested',
        description:
          'The model that answered, the run\'s status, when it started and ended, and how many test cases finished.',
      },
      {
        id: 'tiles',
        target: TOUR_TARGETS.resultsTiles,
        title: 'The Run at a Glance',
        description:
          'View the number of finished test cases, average response latency, and total test errors. High error counts often indicate network connectivity issues rather than model performance.',
        tryIt: 'Hover over a card title for details.',
      },
      {
        id: 'scores',
        target: TOUR_TARGETS.resultsScores,
        title: 'Scores',
        description:
          'One card per measure, averaged over the finished cases.',
        tryIt: 'Hover over a card\'s title to read what it measures, or open its score breakdown.',
      },
      {
        id: 'table',
        target: TOUR_TARGETS.resultsTable,
        title: 'Case by Case',
        description:
          'Each row represents one test case, displaying the request, expected answer, actual response, and performance scores.',
        tryIt: 'Open a row\'s score breakdown and hover a dotted score to read why it scored that way. Search requests or sort by lowest score to find weak responses.',
      },
      {
        id: 'actions',
        target: TOUR_TARGETS.resultsActions,
        title: 'Share the Results',
        description:
          'Download the results as CSV or JSON, or publish them to your Tableau Server as a data source you can build your own views on. While a run is going, its pause, resume, and cancel buttons are here too.',
        tryIt: 'Hover over a button to see what it does.',
      },
    ],
  },
];
