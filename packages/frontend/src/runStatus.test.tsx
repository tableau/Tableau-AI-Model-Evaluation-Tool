/**
 * A status in a table cell keeps to its column: the state on the first
 * line, the detail on a second (2026-10-19: "Completed with 10 errors" ran
 * over the Results column of the history table).
 */

import React from 'react';
import { render, screen } from './testing.cjs';
import { StatusCell } from './runStatus';

test('a completed run with errors puts the error count on its own line', () => {
  render(<StatusCell icon={null} label="Completed with 10 errors" />);
  expect(screen.getByText('Completed')).toBeTruthy();
  expect(screen.getByText('10 errors').className).toBe('status-cell-detail');
});

test('a failed run says why on a second line', () => {
  render(<StatusCell icon={null} label="Failed: every test case had an error" />);
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(screen.getByText('every test case had an error').className).toBe('status-cell-detail');
});

test('a short status is one line', () => {
  render(<StatusCell icon={null} label="Completed" />);
  expect(screen.getByText('Completed')).toBeTruthy();
  expect(screen.queryByText(/errors?/)).toBeNull();
});
