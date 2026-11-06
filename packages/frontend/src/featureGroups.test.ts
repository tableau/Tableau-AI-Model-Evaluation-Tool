import { featureOfRun, featureOfRunner, featureOfSuite } from './featureGroups';

describe('featureOfSuite', () => {
  it('puts every Prep suite on the Prep card, whichever runner serves it', () => {
    // 2026-10-14: the suites moved to adapter prep_server and vanished from
    // the Prep card ("No suites available on this machine").
    expect(featureOfSuite({ adapter: 'prep_server', capability: 'prep-calc' })).toBe('prep');
    expect(featureOfSuite({ adapter: 'prep', capability: 'prep-intent' })).toBe('prep');
    expect(featureOfSuite({ capability: 'prep-flow-plan' })).toBe('prep');
  });

  it('keeps the dashboard and viz suites where they were', () => {
    expect(featureOfSuite({ adapter: 'narratives', capability: 'dashboard-narratives' })).toBe('dashboards');
    expect(featureOfSuite({ adapter: 'cabu', capability: 'dashboard-qa' })).toBe('dashboards');
    expect(featureOfSuite({ adapter: 'agent', capability: 'calc' })).toBe('viz');
    expect(featureOfSuite({ adapter: 'palettes', capability: 'palettes' })).toBe('viz');
  });

  it('sorts a suite by its capability, whatever its adapter is called', () => {
    // 2026-10-20: a frontend that knew the Prep adapter by an older name met
    // a server that had renamed it, so the Prep suites joined the Authoring
    // card and an Evaluate of Authoring queued six suites.
    expect(featureOfSuite({ adapter: 'prep_pipeline_v2', capability: 'prep-calc' })).toBe('prep');
    expect(featureOfSuite({ adapter: 'some_new_adapter', capability: 'dashboard-qa' })).toBe('dashboards');
    expect(featureOfSuite({ adapter: 'some_new_adapter', capability: 'palettes' })).toBe('viz');
    // A capability the table does not list yet still goes by its prefix.
    expect(featureOfSuite({ adapter: 'agent', capability: 'prep-cleaning' })).toBe('prep');
    expect(featureOfSuite({ adapter: 'agent', capability: 'dashboard-alerts' })).toBe('dashboards');
  });

  it('maps run history by runner name', () => {
    expect(featureOfRunner('prep-calc-gen')).toBe('prep');
    expect(featureOfRunner('ect-server')).toBe('viz');
    expect(featureOfRunner('dashboard-viz-narrative-config')).toBe('dashboards');
    expect(featureOfRunner('cabu-dashboard-qa')).toBe('dashboards');
    expect(featureOfRunner(undefined)).toBe('viz');
  });

  it('sorts a run by the capability its launch recorded, then by its runner', () => {
    expect(featureOfRun({ ai_feature: 'prep-intent', runner_name: 'renamed-runner' })).toBe('prep');
    expect(featureOfRun({ ai_feature: 'dashboard-narratives', runner_name: 'renamed-runner' })).toBe('dashboards');
    expect(featureOfRun({ ai_feature: '', runner_name: 'prep-flow-plan-gen' })).toBe('prep');
    expect(featureOfRun({ runner_name: 'calc-prompt' })).toBe('viz');
  });
});
