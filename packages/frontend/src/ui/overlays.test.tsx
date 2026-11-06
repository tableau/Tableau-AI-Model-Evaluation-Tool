/**
 * The overlays' triggers. A confirmation (Popconfirm) attaches its click to
 * its direct child; when that child was a Tooltip the click was dropped and
 * the results page's Cancel button did nothing (bug bash S6-1).
 */

import React from 'react';
// Testing-library with a DOM for bun test.
import { act, fireEvent, render, screen } from '../testing.cjs';
import { Button, message, Popconfirm, Tooltip } from './index';

describe('toast lifecycle', () => {
  it('cancels dismissals, removes its independent root, and can mount again', () => {
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    const timers: ReturnType<typeof window.setTimeout>[] = [];
    const cleared: ReturnType<typeof window.setTimeout>[] = [];
    window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => {
      const timer = originalSetTimeout.apply(window, args);
      timers.push(timer);
      return timer;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timer: Parameters<typeof window.clearTimeout>[0]) => {
      cleared.push(timer!);
      originalClearTimeout.call(window, timer);
    }) as typeof window.clearTimeout;
    try {
      act(() => {
        message.success('First toast', 60);
        message.error('Second toast', 60);
      });
      expect(screen.getAllByRole('status')).toHaveLength(2);
      const host = document.querySelector('.tui-toasts')!.parentElement!;
      act(() => message.destroy());
      expect(cleared).toEqual(timers);
      expect(host.isConnected).toBe(false);
      expect(screen.queryByRole('status')).toBeNull();
      act(() => message.destroy());
      act(() => message.info('New toast', 60));
      expect(screen.getByRole('status').textContent).toBe('New toast');
    } finally {
      act(() => message.destroy());
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  });

  it('expires a toast normally', async () => {
    act(() => message.info('Short-lived toast', 0.01));
    expect(screen.getByRole('status').textContent).toBe('Short-lived toast');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('a confirmation around a button', () => {
  for (const { tooltipOutside, stopPropagation } of [
    { tooltipOutside: true, stopPropagation: false },
    { tooltipOutside: false, stopPropagation: false },
    { tooltipOutside: true, stopPropagation: true },
  ]) {
    it(`keeps the trigger tooltip out of the confirmation with the tooltip ${tooltipOutside ? 'outside' : 'inside'}${stopPropagation ? ' and a click that stops propagation' : ''}`, () => {
      const onConfirm = jest.fn();
      const button = <Button aria-label="Evaluate all" onClick={stopPropagation ? (e) => e.stopPropagation() : undefined} />;
      const confirmation = (child: React.ReactNode) => (
        <Popconfirm title="Evaluate all suites?" onConfirm={onConfirm}>{child}</Popconfirm>
      );
      render(tooltipOutside ? (
        <Tooltip title="Evaluate every suite">{confirmation(button)}</Tooltip>
      ) : confirmation(<Tooltip title="Evaluate every suite">{button}</Tooltip>));

      const trigger = screen.getByRole('button', { name: 'Evaluate all' });
      fireEvent.mouseOver(trigger);
      expect(screen.getByRole('tooltip').textContent).toBe('Evaluate every suite');
      fireEvent.click(trigger);
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.mouseOut(trigger);
      const title = screen.getByText('Evaluate all suites?');
      fireEvent.mouseOver(title);
      expect(screen.queryByRole('tooltip')).toBeNull();
      const confirm = screen.getByRole('button', { name: 'OK' });
      fireEvent.mouseOver(confirm);
      fireEvent.focus(confirm);
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.click(confirm);
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Evaluate all suites?')).toBeNull();

      // Dismissing the confirmation does not disable ordinary trigger help.
      fireEvent.mouseOver(trigger);
      expect(screen.getByRole('tooltip')).toBeTruthy();
      fireEvent.mouseOut(trigger);
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.focus(trigger);
      expect(screen.getByRole('tooltip')).toBeTruthy();
      fireEvent.blur(trigger);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  }

  it('opens on the click and runs onConfirm from OK', () => {
    const onConfirm = jest.fn();
    render(
      <Popconfirm title="Cancel this run?" onConfirm={onConfirm}>
        <Button aria-label="Cancel the running suite" />
      </Popconfirm>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the running suite' }));
    expect(screen.getByText('Cancel this run?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('still opens when a tooltip sits between it and the button', () => {
    const onConfirm = jest.fn();
    render(
      <Popconfirm title="Cancel this run?" onConfirm={onConfirm}>
        <Tooltip title="Cancel this run">
          <Button aria-label="Cancel the running suite" />
        </Tooltip>
      </Popconfirm>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the running suite' }));
    expect(screen.getByText('Cancel this run?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('still opens through a tooltip that has nothing to show', () => {
    const onConfirm = jest.fn();
    render(
      <Popconfirm title="Cancel this run?" onConfirm={onConfirm}>
        <Tooltip title="">
          <Button aria-label="Cancel the running suite" />
        </Tooltip>
      </Popconfirm>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the running suite' }));
    expect(screen.getByText('Cancel this run?')).toBeTruthy();
  });
});
