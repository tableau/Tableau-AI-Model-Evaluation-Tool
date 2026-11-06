/**
 * The table's widths: growing columns fill the room the table has, and a
 * table wider than its room keeps its columns' widths and gets the sideways
 * scrollbar that stays in view (bug bash S6-2). jsdom lays nothing out, so
 * the room and the table's own width are stated by each test.
 */

import React from 'react';
// Testing-library with a DOM for bun test.
import { fireEvent, render, screen } from '../testing.cjs';
import { Table } from './Table';

type Row = { id: string; a: string; b: string; c: string; d: string };
const rows: Row[] = [{ id: '1', a: 'a', b: 'b', c: 'c', d: 'd' }];
const columns = [
  { title: 'A', dataIndex: 'a', key: 'a', width: 100 },
  { title: 'B', dataIndex: 'b', key: 'b', width: 200, flex: true },
  { title: 'C', dataIndex: 'c', key: 'c', width: 300, flex: true },
  { title: 'D', dataIndex: 'd', key: 'd', width: 50, fixed: 'right' as const },
];

/** How wide the table's place is, and how wide the table itself is laid out. */
const layOut = (room: number, table: number) => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return room; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return table; } });
};

const colWidths = () =>
  // eslint-disable-next-line testing-library/no-node-access
  Array.from(document.querySelectorAll('colgroup col')).map((c) => (c as HTMLElement).style.width);
// eslint-disable-next-line testing-library/no-node-access
const tableWidth = () => (document.querySelector('table') as HTMLElement).style.width;

afterEach(() => {
  delete (HTMLElement.prototype as any).clientWidth;
  delete (HTMLElement.prototype as any).scrollWidth;
});

describe('table pagination', () => {
  const pagedRows = Array.from({ length: 23 }, (_, i) => ({ ...rows[0], id: String(i + 1), a: `Row ${i + 1}` }));

  it('jumps to the first and last pages from either pager and disables boundary controls', () => {
    render(<Table columns={columns} dataSource={pagedRows} rowKey="id" pagination={{ pageSize: 10, position: 'both' }} />);
    for (const label of ['First page', 'Previous page']) {
      expect(screen.getAllByRole('button', { name: label }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    }
    fireEvent.click(screen.getAllByRole('button', { name: 'Last page' })[0]);
    expect(screen.getAllByText('Page 3 of 3')).toHaveLength(2);
    expect(screen.getByText('Row 21')).toBeTruthy();
    expect(screen.queryByText('Row 1')).toBeNull();
    for (const label of ['Last page', 'Next page']) {
      expect(screen.getAllByRole('button', { name: label }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    }
    fireEvent.click(screen.getAllByRole('button', { name: 'Previous page' })[1]);
    expect(screen.getAllByText('Page 2 of 3')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'First page' })[1]);
    expect(screen.getAllByText('Page 1 of 3')).toHaveLength(2);
    expect(screen.getByText('Row 1')).toBeTruthy();
  });

  it('supports independent controlled pages and resets the controlled page when the size changes', () => {
    function SuiteTables() {
      const [suite, setSuite] = React.useState('A');
      const [pages, setPages] = React.useState<Record<string, number>>({});
      return <>
        <button onClick={() => setSuite(suite === 'A' ? 'B' : 'A')}>Switch suite</button>
        <Table columns={columns} dataSource={pagedRows} rowKey="id" pagination={{
          pageSize: 10, showSizeChanger: true,
          current: pages[suite] ?? 1,
          onChange: page => setPages(prev => ({ ...prev, [suite]: page })),
        }} />
      </>;
    }
    render(<SuiteTables />);
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch suite' }));
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch suite' }));
    expect(screen.getByText('Page 3 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch suite' }));
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '20' } });
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
  });
});

describe('the table', () => {
  it('hands the spare room to the growing columns in proportion to their widths', () => {
    layOut(1000, 1000);
    render(<Table columns={columns} dataSource={rows} rowKey="id" pagination={false} scroll={{ x: 650 }} />);
    // 350 spare: 140 to B (200 of 500), 210 to C.
    expect(colWidths()).toEqual(['100px', '340px', '510px', '50px']);
    expect(tableWidth()).toBe('1000px');
    expect(screen.queryByTestId('table-sideways-scrollbar')).toBeNull();
  });

  it('keeps the columns at their widths and scrolls sideways when there is not enough room', () => {
    layOut(400, 650);
    render(<Table columns={columns} dataSource={rows} rowKey="id" pagination={false} scroll={{ x: 650 }} />);
    expect(colWidths()).toEqual(['100px', '200px', '300px', '50px']);
    expect(tableWidth()).toBe('650px');
    expect(screen.getByTestId('table-sideways-scrollbar')).toBeTruthy();
    // The shadow marks the clipped side, against the pinned column.
    // eslint-disable-next-line testing-library/no-node-access
    const scroller = document.querySelector('.tui-table-scroller') as HTMLElement;
    expect(scroller.className).toContain('tui-table-more-right');
    expect(scroller.className).not.toContain('tui-table-more-left');
    expect(scroller.style.getPropertyValue('--tui-pinned-width')).toBe('50px');
  });

  it('leaves a table without growing columns at its declared width', () => {
    layOut(1000, 1000);
    const plain = columns.map(({ flex, ...c }) => c);
    render(<Table columns={plain} dataSource={rows} rowKey="id" pagination={false} scroll={{ x: 650 }} />);
    expect(colWidths()).toEqual(['100px', '200px', '300px', '50px']);
    expect(tableWidth()).toBe('650px');
  });
});

describe('moving a column', () => {
  it('reports a header dropped onto another, and leaves pinned headers alone', () => {
    const moved: string[][] = [];
    render(<Table columns={columns} dataSource={rows} rowKey="id" pagination={false} onColumnMove={(from, to) => moved.push([from, to])} />);
    const a = screen.getByRole('columnheader', { name: 'A' });
    const c = screen.getByRole('columnheader', { name: 'C' });
    const d = screen.getByRole('columnheader', { name: 'D' });
    expect(a.getAttribute('draggable')).toBe('true');
    expect(d.getAttribute('draggable')).toBeNull();
    fireEvent.dragStart(a);
    fireEvent.dragOver(c);
    expect(c.className).toContain('tui-th-drag-over');
    fireEvent.drop(c);
    expect(moved).toEqual([['a', 'c']]);
    expect(c.className).not.toContain('tui-th-drag-over');
  });

  it('has no draggable headers without a handler', () => {
    render(<Table columns={columns} dataSource={rows} rowKey="id" pagination={false} />);
    expect(screen.getByRole('columnheader', { name: 'A' }).getAttribute('draggable')).toBeNull();
  });
});
