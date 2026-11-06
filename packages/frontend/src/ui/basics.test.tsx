import React from 'react';
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '../testing.cjs';
import { Button, Card, Drawer, Input, Popconfirm, Select, Space, Tooltip } from './index';
import { PauseOutlined, StopOutlined } from './icons';

describe('icon-only toolbar alignment', () => {
  it('centers icons and nested overlay anchors without baseline spacing', () => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
    document.head.appendChild(stylesheet);
    try {
      render(
        <Space>
          <Tooltip title="Pause all suites">
            <Button icon={<PauseOutlined />} aria-label="Pause all" />
          </Tooltip>
          <Tooltip title="Cancel all suites">
            <Popconfirm title="Cancel all suites?">
              <Button danger icon={<StopOutlined />} aria-label="Cancel all" />
            </Popconfirm>
          </Tooltip>
        </Space>,
      );
      for (const name of ['Pause all', 'Cancel all']) {
        const button = screen.getByRole('button', { name });
        const style = window.getComputedStyle(button);
        expect(style.display).toBe('inline-flex');
        expect(style.alignItems).toBe('center');
        expect(style.justifyContent).toBe('center');
        expect(style.verticalAlign).toBe('middle');
        let anchor = button.parentElement;
        while (anchor?.classList.contains('tui-anchor')) {
          const anchorStyle = window.getComputedStyle(anchor);
          expect(anchorStyle.display).toBe('inline-flex');
          expect(anchorStyle.alignItems).toBe('center');
          expect(anchorStyle.verticalAlign).toBe('middle');
          anchor = anchor.parentElement;
        }
      }
      fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
      expect(screen.getByText('Cancel all suites?')).toBeTruthy();
    } finally {
      stylesheet.remove();
    }
  });
});

describe('small dropdown text alignment', () => {
  it('sizes the bordered container and keeps the native select inside it', () => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
    document.head.appendChild(stylesheet);
    try {
      render(<Select size="small" aria-label="History filter" value="all"
        options={[{ value: 'all', label: 'All features' }]} />);
      const select = screen.getByRole('combobox', { name: 'History filter' });
      const field = select.parentElement!;
      expect(window.getComputedStyle(field).height).toBe('28px');
      expect(select.style.height).toBe('100%');
      expect(select.style.boxSizing).toBe('border-box');
    } finally {
      stylesheet.remove();
    }
  });
});

describe('drawer form field backgrounds', () => {
  it('gives enabled text, password and select fields a white surface, not disabled fields', () => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
    document.head.appendChild(stylesheet);
    try {
      render(
        <Drawer open title="Setup" onClose={() => {}}>
          <Card type="inner">
            <Input aria-label="Server URL" onChange={() => {}} />
            <Input.Password aria-label="API key" onChange={() => {}} />
            <Select aria-label="Provider" options={[{ value: 'openai', label: 'OpenAI' }]} />
            <Input aria-label="Disabled input" disabled />
            <Select aria-label="Disabled select" disabled />
          </Card>
        </Drawer>,
      );
      for (const name of ['Server URL', 'API key', 'Provider']) {
        const field = screen.getByLabelText(name);
        expect(window.getComputedStyle(field).backgroundColor).toBe('#fff');
        fireEvent.focus(field);
        expect(window.getComputedStyle(field).backgroundColor).toBe('#fff');
      }
      for (const name of ['Disabled input', 'Disabled select']) {
        const field = screen.getByLabelText(name);
        expect(field.hasAttribute('disabled')).toBe(true);
        expect(window.getComputedStyle(field).backgroundColor).not.toBe('#fff');
      }
    } finally {
      stylesheet.remove();
    }
  });
});
