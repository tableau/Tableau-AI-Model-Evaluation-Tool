import React from 'react';
import { expect, test } from 'bun:test';
import { render, screen } from './testing.cjs';
import { EvaluationFeedback } from './EvaluationFeedback';

test('request feedback never claims execution; committed queue and preparation have distinct wording', () => {
  const view = render(<EvaluationFeedback pending="Submitting evaluation… Waiting for the server to confirm it." />);
  expect(screen.getByRole('status').textContent).toContain('Submitting evaluation');
  expect(screen.queryByText(/Running/)).toBeNull();
  view.rerender(<EvaluationFeedback status="queued" phase="Preparing evaluation" />);
  expect(screen.getByRole('status').textContent).toContain('previous evaluation still stopping');
  expect(screen.queryByText('Preparing evaluation…')).toBeNull();
  view.rerender(<EvaluationFeedback status="started" phase="Preparing evaluation" />);
  expect(screen.getByRole('status').textContent).toBe('Preparing evaluation…');
  view.rerender(<EvaluationFeedback status="started" phase="Publishing sample content" />);
  expect(screen.getByRole('status').textContent).toBe('Publishing sample content…');
  view.rerender(<EvaluationFeedback status="finished" />);
  expect(screen.queryByRole('status')).toBeNull();
});

test('connection loss explains that the displayed run state is last confirmed, not a failed execution', () => {
  render(<EvaluationFeedback status="started" reconnecting />);
  expect(screen.getByRole('status').textContent).toContain('last confirmed evaluation state');
});
