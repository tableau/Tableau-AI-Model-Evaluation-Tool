/** Make a feature Evaluate's unpublished Q&A exclusions visible. */
import React from 'react';
import type { Suite } from './launch';
import { Alert, Button } from './ui';

export const dashboardSuitesNeedingContent = (
  suites: Suite[],
  content: { suites: Record<string, { published: boolean }> } | null,
): Suite[] => suites.filter((s) =>
  s.available && s.path && s.server_supported !== false && s.adapter === 'cabu' && s.content
  && !content?.suites?.[s.content]?.published,
);

export const DashboardPreparation: React.FC<{
  suites: Suite[];
  loaded: boolean;
  statusAvailable: boolean;
  onSetUp: (suite: Suite) => void;
}> = ({ suites, loaded, statusAvailable, onSetUp }) => {
  if (!suites.length) return null;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 16 }}
      message={!loaded ? 'Checking sample dashboards…' : !statusAvailable
        ? 'Sample dashboard status could not be checked'
        : 'Some dashboard suites need sample content'}
      description={
        <div>
          <p>Evaluate on the feature card does not include the following Questions about a dashboard suites until their sample content is published on the connected site. Open each suite’s set-up and choose Publish Sample Content.</p>
          {suites.map((suite) => (
            <div key={suite.id}>
              <Button type="link" onClick={() => onSetUp(suite)}>Set up {suite.label}</Button>
            </div>
          ))}
        </div>
      }
    />
  );
};
