/**
 * Collapse and Tabs adapters over the Tableau UI library's Disclosure and
 * Tabs widgets, with the item shape the pages already use.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as TUI from "@tableau/tableau-ui";
import { cx } from "./basics";

export interface CollapseItem {
  key: string;
  label: React.ReactNode;
  extra?: React.ReactNode;
  /** A row under the header that stays visible when the item is collapsed
   *  and may hold buttons or links. The header itself is a button, so
   *  interactive content cannot go in `label`. */
  summary?: React.ReactNode;
  children?: React.ReactNode;
  collapsible?: "header" | "icon" | "disabled";
  showArrow?: boolean;
}

export interface CollapseProps {
  items: CollapseItem[];
  activeKey?: string | string[];
  defaultActiveKey?: string | string[];
  onChange?: (keys: string[]) => void;
  ghost?: boolean;
  bordered?: boolean;
  size?: "small" | "middle" | "large";
  style?: React.CSSProperties;
  className?: string;
}

const toArray = (k?: string | string[]) => (k === undefined ? [] : Array.isArray(k) ? k : [k]);

/** One expandable row: the library's Disclosure, with actions overlaid on
 *  the right of its header (the header is a button, so the actions cannot
 *  be nested inside it). */
const Item: React.FC<{
  item: CollapseItem;
  expanded: boolean;
  onToggle: (open: boolean) => void;
  ghost?: boolean;
}> = ({ item, expanded, onToggle, ghost }) => {
  const extraRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [extraWidth, setExtraWidth] = useState(0);
  useLayoutEffect(() => {
    if (extraRef.current) setExtraWidth(extraRef.current.getBoundingClientRect().width + 24);
  }, [item.extra]);
  const inert = item.collapsible === "disabled";
  if (inert) {
    return (
      <div className="tui-collapse-item tui-collapse-static">
        {item.label}
        {item.extra ? <div className="tui-collapse-extra">{item.extra}</div> : null}
      </div>
    );
  }
  return (
    <div
      ref={wrapRef}
      className={cx("tui-collapse-item", item.extra && "tui-has-extra", item.summary && "tui-has-summary")}
      style={item.extra ? ({ "--tui-extra-width": `${extraWidth}px` } as React.CSSProperties) : undefined}
    >
      <TUI.Disclosure
        label={item.label}
        // The library's header is a <button> with no type: inside a <form> a
        // click submitted it (the connection drawer re-ran its test when
        // "Connection Details" was opened, bug bash 2026-10-23, item 19).
        buttonAttrs={{ type: "button" }}
        isExpanded={expanded}
        onExpand={() => onToggle(true)}
        onCollapse={() => onToggle(false)}
        noBackgroundWhenExpanded={ghost}
        keepChildrenMounted={false}
      >
        {/* With a summary row the body is rendered below that row instead
            (the library puts its content straight under the header). */}
        {item.summary ? null : <div className="tui-collapse-body">{item.children}</div>}
      </TUI.Disclosure>
      {item.summary ? <div className="tui-collapse-summary">{item.summary}</div> : null}
      {item.summary && expanded ? <div className="tui-collapse-body">{item.children}</div> : null}
      {item.extra ? <div ref={extraRef} className="tui-collapse-extra">{item.extra}</div> : null}
    </div>
  );
};

export const Collapse: React.FC<CollapseProps> = ({ items, activeKey, defaultActiveKey, onChange, ghost, bordered, style, className }) => {
  const [inner, setInner] = useState<string[]>(toArray(defaultActiveKey));
  const keys = activeKey !== undefined ? toArray(activeKey) : inner;
  useEffect(() => { if (activeKey !== undefined) setInner(toArray(activeKey)); }, [activeKey]);
  const toggle = (key: string, open: boolean) => {
    const next = open ? Array.from(new Set([...keys, key])) : keys.filter((k) => k !== key);
    setInner(next);
    onChange?.(next);
  };
  return (
    <div className={cx((bordered || !ghost) && "tui-collapse-bordered", className)} style={style}>
      {items.map((item) => (
        <Item key={item.key} item={item} expanded={keys.includes(item.key)} onToggle={(o) => toggle(item.key, o)} ghost={ghost} />
      ))}
    </div>
  );
};

export interface TabItem {
  key: string;
  label: React.ReactNode;
  /** The tab's plain-text name when `label` is not a string (an icon beside it). */
  title?: string;
  children?: React.ReactNode;
}

export const Tabs: React.FC<{
  items: TabItem[];
  activeKey?: string;
  defaultActiveKey?: string;
  onChange?: (key: string) => void;
  style?: React.CSSProperties;
  className?: string;
}> = ({ items, activeKey, defaultActiveKey, onChange, style, className }) => {
  const [inner, setInner] = useState(defaultActiveKey || items[0]?.key);
  const current = activeKey ?? inner;
  const index = Math.max(0, items.findIndex((t) => t.key === current));
  // The library's Tabs is a tab strip: each item's `content` is the tab's
  // label and the selected panel is rendered as the strip's children.
  return (
    <div style={style} className={cx("tui-tabs", className)}>
      <TUI.Tabs
        alignment="left"
        selectedTabIndex={index}
        onTabChange={(i) => { const k = items[i]?.key; if (k === undefined) return; setInner(k); onChange?.(k); }}
        tabs={items.map((t) => ({
          title: t.title ?? (typeof t.label === "string" ? t.label : t.key),
          content: t.label,
        }))}
      >
        <div style={{ paddingTop: 16 }}>{items[index]?.children}</div>
      </TUI.Tabs>
    </div>
  );
};
