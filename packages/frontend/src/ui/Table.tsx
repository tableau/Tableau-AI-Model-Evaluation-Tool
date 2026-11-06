/**
 * A data table in the Tableau UI idiom: gray header row, hairline rows,
 * optional sticky right-hand columns, expandable rows and pagination. The
 * column definition follows the pages' existing usage.
 *
 * Width: a column's `width` is what it needs. A column marked `flex` grows
 * when the table has more room than its columns need, so the table fills its
 * place instead of leaving the right-hand side empty. When the columns need
 * more than there is, the table keeps their widths and scrolls sideways,
 * with a scrollbar that stays at the bottom of the window and shadows on the
 * clipped edges (bug bash S6-2: the browser's own scrollbar sat under the
 * last of 50 rows, and a desktop mouse has no sideways scroll).
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Select, Skeleton, cx } from "./basics";
import { DownOutlined, LeftOutlined, RightOutlined, StepBackwardOutlined, StepForwardOutlined } from "./icons";

export interface ColumnType<T> {
  title?: React.ReactNode;
  key?: string;
  dataIndex?: keyof T | string;
  /** A plain name for a column picker, when the title is not plain text. */
  label?: string;
  /** The width the column needs, in pixels. */
  width?: number | string;
  /** Grows with the room the table has; `width` is then its minimum. */
  flex?: boolean;
  align?: "left" | "center" | "right";
  ellipsis?: boolean;
  fixed?: "left" | "right";
  render?: (value: any, row: T, index: number) => React.ReactNode;
}
export type ColumnsType<T> = ColumnType<T>[];

export interface TableProps<T> {
  columns: ColumnsType<T>;
  dataSource: T[];
  rowKey: string | ((row: T) => string);
  size?: "small" | "middle" | "large";
  loading?: boolean;
  pagination?: false | {
    /** Controlled page, for callers that keep a separate position per suite. */
    current?: number;
    onChange?: (page: number) => void;
    pageSize?: number;
    showSizeChanger?: boolean;
    pageSizeOptions?: string[];
    showTotal?: (total: number, range: [number, number]) => React.ReactNode;
    /** Where the page controls sit; "both" repeats them above the table. */
    position?: "bottom" | "both";
    /** Lays out the line above the table: it is handed the page controls
     *  (null when there is nothing to page through) and returns the whole
     *  line, so a page can put its search and filters on the same line. */
    renderTop?: (pager: React.ReactNode) => React.ReactNode;
  };
  expandable?: {
    rowExpandable?: (row: T) => boolean;
    expandedRowRender?: (row: T) => React.ReactNode;
  };
  onRow?: (row: T, index: number) => React.HTMLAttributes<HTMLTableRowElement> & { style?: React.CSSProperties };
  locale?: { emptyText?: React.ReactNode };
  /** The width the columns need together; omitted, it is the sum of their
   *  widths. Given, the columns keep their declared widths (fixed layout)
   *  and pinned columns line up exactly. */
  scroll?: { x?: number | string };
  className?: string;
  style?: React.CSSProperties;
  /** Given, a column header (not a pinned one) can be dragged onto another
   *  header; this is called with the two keys and the caller reorders. */
  onColumnMove?: (fromKey: string, toKey: string) => void;
}

const EXPAND_COLUMN_WIDTH = 32;
const px = (w: number | string | undefined): number => Number(w) || 0;

/** The width of an element, kept up to date as the window changes. */
function useElementWidth(ref: React.RefObject<HTMLElement>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(el.clientWidth || null);
    read();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(read);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [ref]);
  return width;
}

interface SidewaysScroll {
  /** The table is wider than its place. */
  overflow: boolean;
  moreLeft: boolean;
  moreRight: boolean;
  scrollWidth: number;
}

const NO_SCROLL: SidewaysScroll = { overflow: false, moreLeft: false, moreRight: false, scrollWidth: 0 };

export function Table<T extends Record<string, any>>({
  columns, dataSource, rowKey, size, loading, pagination, expandable, onRow, locale, scroll, className, style, onColumnMove,
}: TableProps<T>) {
  const keyOf = (row: T) => (typeof rowKey === "function" ? rowKey(row) : String(row[rowKey]));
  const [page, setPage] = useState(1);
  const [chosenPageSize, setPageSize] = useState<number | null>(null);
  // Seeded from props each render until the user picks a size, so a table
  // that first rendered without pagination (data still loading) paginates
  // correctly once it has rows.
  const pageSize = pagination ? chosenPageSize || pagination.pageSize || 10 : 0;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const total = dataSource.length;
  const pages = pagination ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const current = Math.max(1, Math.min((pagination ? pagination.current : undefined) ?? page, pages));
  const changePage = (next: number) => {
    setPage(next);
    if (pagination) pagination.onChange?.(next);
  };
  const rows = pagination ? dataSource.slice((current - 1) * pageSize, current * pageSize) : dataSource;

  const canExpand = (row: T) => Boolean(expandable?.expandedRowRender && (expandable.rowExpandable ? expandable.rowExpandable(row) : true));
  const hasExpandColumn = Boolean(expandable?.expandedRowRender);

  // Sticky right-hand columns: the last one sits at 0, the one before it
  // at the last one's width, and so on.
  const rightOffsets = useMemo(() => {
    const out = new Map<number, number>();
    let acc = 0;
    for (let i = columns.length - 1; i >= 0; i -= 1) {
      if (columns[i].fixed === "right") {
        out.set(i, acc);
        acc += px(columns[i].width) || 80;
      }
    }
    return out;
  }, [columns]);
  const pinnedWidth = useMemo(
    () => columns.reduce((sum, c) => sum + (c.fixed === "right" ? px(c.width) || 80 : 0), 0),
    [columns],
  );

  // ---- widths ---------------------------------------------------------------
  const wrapRef = useRef<HTMLDivElement>(null);
  const roomWidth = useElementWidth(wrapRef);
  const fixedLayout = Boolean(scroll?.x);
  const { tableWidth, colWidths } = useMemo(() => {
    if (!fixedLayout) return { tableWidth: undefined as number | undefined, colWidths: columns.map((c) => c.width) };
    const needed =
      (typeof scroll!.x === "number" ? scroll!.x : 0) ||
      columns.reduce((sum, c) => sum + px(c.width), 0) + (hasExpandColumn ? EXPAND_COLUMN_WIDTH : 0);
    const flexMin = columns.reduce((sum, c) => sum + (c.flex ? px(c.width) : 0), 0);
    const spare = roomWidth && flexMin > 0 ? Math.max(0, roomWidth - needed) : 0;
    // Each growing column takes a share of the spare room in proportion to
    // what it needs; the last one takes the rounding remainder, so the
    // columns add up to the table exactly.
    let handedOut = 0;
    let lastFlex = -1;
    columns.forEach((c, i) => { if (c.flex) lastFlex = i; });
    const widths = columns.map((c, i) => {
      if (!c.flex || spare === 0) return c.width;
      const share = i === lastFlex ? spare - handedOut : Math.floor((spare * px(c.width)) / flexMin);
      handedOut += share;
      return px(c.width) + share;
    });
    return { tableWidth: needed + spare, colWidths: widths };
  }, [fixedLayout, scroll, columns, hasExpandColumn, roomWidth]);

  // ---- sideways scrolling -----------------------------------------------------
  const barRef = useRef<HTMLDivElement>(null);
  const [sideways, setSideways] = useState<SidewaysScroll>(NO_SCROLL);
  const readSideways = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 1;
    const next: SidewaysScroll = {
      overflow,
      moreLeft: overflow && el.scrollLeft > 0,
      moreRight: overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      scrollWidth: el.scrollWidth,
    };
    setSideways((prev) =>
      prev.overflow === next.overflow && prev.moreLeft === next.moreLeft && prev.moreRight === next.moreRight && prev.scrollWidth === next.scrollWidth
        ? prev
        : next);
  }, []);
  useLayoutEffect(readSideways, [readSideways, roomWidth, tableWidth, rows.length, columns.length, loading]);
  const onWrapScroll = () => {
    if (barRef.current && wrapRef.current) barRef.current.scrollLeft = wrapRef.current.scrollLeft;
    readSideways();
  };
  const onBarScroll = () => {
    if (barRef.current && wrapRef.current) wrapRef.current.scrollLeft = barRef.current.scrollLeft;
  };

  const cell = (col: ColumnType<T>, row: T, index: number) => {
    const value = col.dataIndex ? row[col.dataIndex as string] : undefined;
    return col.render ? col.render(value, row, index) : (value as React.ReactNode);
  };

  // ---- dragging a header onto another ---------------------------------------
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const movable = (col: ColumnType<T>) => Boolean(onColumnMove && col.key && col.fixed !== "right");
  const dragProps = (col: ColumnType<T>): React.HTMLAttributes<HTMLTableCellElement> => {
    if (!movable(col)) return {};
    const key = String(col.key);
    const end = () => { setDragKey(null); setOverKey(null); };
    return {
      draggable: true,
      title: "Drag to move this column",
      onDragStart: (e) => {
        setDragKey(key);
        try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", key); } catch { /* no dataTransfer in a test DOM */ }
      },
      onDragOver: (e) => {
        if (!dragKey || dragKey === key) return;
        e.preventDefault();
        if (overKey !== key) setOverKey(key);
      },
      onDragLeave: () => { if (overKey === key) setOverKey(null); },
      onDrop: (e) => {
        e.preventDefault();
        if (dragKey && dragKey !== key) onColumnMove!(dragKey, key);
        end();
      },
      onDragEnd: end,
    };
  };

  const cellStyle = (col: ColumnType<T>, i: number): React.CSSProperties => ({
    textAlign: col.align,
    width: colWidths[i],
    minWidth: colWidths[i],
    ...(col.ellipsis ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: colWidths[i] } : {}),
    ...(rightOffsets.has(i) ? { right: rightOffsets.get(i) } : {}),
  });

  // The page controls; rendered under the table and, on request, above it
  // too, so a long page can be left from either end.
  const pager = (where: "top" | "bottom") =>
    pagination && total > 0 && (pages > 1 || pagination.showSizeChanger) ? (
      <div className={cx("tui-pagination", where === "top" && "tui-pagination-top")}>
        {pagination.showTotal && <span>{pagination.showTotal(total, [(current - 1) * pageSize + 1, Math.min(total, current * pageSize)])}</span>}
        <button type="button" className="tui-page-btn" aria-label="First page" title="First page" disabled={current <= 1} onClick={() => changePage(1)}>
          <StepBackwardOutlined />
        </button>
        <button type="button" className="tui-page-btn" aria-label="Previous page" title="Previous page" disabled={current <= 1} onClick={() => changePage(current - 1)}>
          <LeftOutlined />
        </button>
        <span>Page {current} of {pages}</span>
        <button type="button" className="tui-page-btn" aria-label="Next page" title="Next page" disabled={current >= pages} onClick={() => changePage(current + 1)}>
          <RightOutlined />
        </button>
        <button type="button" className="tui-page-btn" aria-label="Last page" title="Last page" disabled={current >= pages} onClick={() => changePage(pages)}>
          <StepForwardOutlined />
        </button>
        {pagination.showSizeChanger && (
          <span className="tui-page-size">
            <Select
              aria-label="Rows per page"
              value={String(pageSize)}
              onChange={(v) => { setPageSize(Number(v)); changePage(1); }}
              options={(pagination.pageSizeOptions || ["10", "20", "50"]).map((n) => ({ value: n, label: `${n} per page` }))}
            />
          </span>
        )}
      </div>
    ) : null;

  // The line above the table and the page controls under it stay put; only
  // the table itself scrolls sideways when it is wider than the page.
  return (
    <div className={cx("tui-table-outer", className)} style={style}>
      {pagination && pagination.renderTop
        ? pagination.renderTop(pager("top"))
        : pagination && pagination.position === "both" && pager("top")}
      <div
        className={cx(
          "tui-table-scroller",
          sideways.overflow && "tui-table-overflow",
          sideways.moreLeft && "tui-table-more-left",
          sideways.moreRight && "tui-table-more-right",
        )}
        style={{ "--tui-pinned-width": `${pinnedWidth}px` } as React.CSSProperties}
      >
      <div className="tui-table-wrap" ref={wrapRef} onScroll={onWrapScroll}>
      <table
        className={cx("tui-table", size === "small" && "tui-table-small")}
        // With a declared total width the columns keep their declared
        // widths (fixed layout); pinned columns then line up exactly.
        style={fixedLayout ? { minWidth: tableWidth, width: tableWidth, tableLayout: "fixed" } : undefined}
      >
        {fixedLayout && (
          <colgroup>
            {hasExpandColumn && <col style={{ width: EXPAND_COLUMN_WIDTH }} />}
            {columns.map((col, i) => (
              <col key={col.key || String(col.dataIndex) || i} style={{ width: colWidths[i] }} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {hasExpandColumn && <th style={{ width: EXPAND_COLUMN_WIDTH }} aria-label="Expand" />}
            {columns.map((col, i) => (
              <th
                key={col.key || String(col.dataIndex) || i}
                className={cx(
                  rightOffsets.has(i) && "tui-fixed-right",
                  movable(col) && "tui-th-draggable",
                  dragKey && dragKey === col.key && "tui-th-dragging",
                  overKey && overKey === col.key && "tui-th-drag-over",
                )}
                style={cellStyle(col, i)}
                {...dragProps(col)}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={columns.length + (hasExpandColumn ? 1 : 0)}><Skeleton active title={false} paragraph={{ rows: 3 }} /></td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={columns.length + (hasExpandColumn ? 1 : 0)}><div className="tui-table-empty">{locale?.emptyText ?? "No data"}</div></td></tr>
          ) : (
            rows.map((row, idx) => {
              const k = keyOf(row);
              const index = pagination ? (current - 1) * pageSize + idx : idx;
              const extra = onRow?.(row, index) || {};
              const isOpen = expanded.has(k);
              return (
                <React.Fragment key={k}>
                  <tr {...extra}>
                    {hasExpandColumn && (
                      <td style={{ width: EXPAND_COLUMN_WIDTH }}>
                        {canExpand(row) && (
                          <button
                            type="button"
                            className="tui-table-expand"
                            aria-label={isOpen ? "Collapse row" : "Expand row"}
                            aria-expanded={isOpen}
                            onClick={() => setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                          >
                            {isOpen ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />}
                          </button>
                        )}
                      </td>
                    )}
                    {columns.map((col, i) => (
                      <td key={col.key || String(col.dataIndex) || i} className={cx(rightOffsets.has(i) && "tui-fixed-right")} style={cellStyle(col, i)}>
                        {cell(col, row, index)}
                      </td>
                    ))}
                  </tr>
                  {isOpen && canExpand(row) && (
                    <tr className="tui-table-expanded">
                      <td colSpan={columns.length + 1}>{expandable!.expandedRowRender!(row)}</td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>
      </div>
      {sideways.overflow && (
        // Stands in for the browser's scrollbar, which would sit under the
        // last row: this one stays at the bottom of the window.
        <div className="tui-table-hscroll" ref={barRef} onScroll={onBarScroll} aria-hidden="true" data-testid="table-sideways-scrollbar">
          <div style={{ width: sideways.scrollWidth, height: 1 }} />
        </div>
      )}
      </div>
      {pager("bottom")}
    </div>
  );
}
