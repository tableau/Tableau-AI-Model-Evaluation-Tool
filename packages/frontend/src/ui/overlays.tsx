/**
 * Overlays the open-source Tableau UI library does not ship: tooltip,
 * popover, confirm popover, dialog, drawer and toasts. Positioned with fixed
 * coordinates from the anchor's bounding box and drawn with the library's
 * design tokens (ui.css).
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Button, cx } from "./basics";
import { CheckCircleFilled, CloseCircleFilled, CloseOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from "./icons";

export type Placement =
  | "top" | "bottom" | "left" | "right"
  | "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | "rightTop" | "leftTop";

const GAP = 8;

function position(anchor: DOMRect, box: { width: number; height: number }, placement: Placement) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top: number;
  let left: number;
  const base = placement.replace(/(Left|Right|Top)$/, "");
  switch (base) {
    case "bottom":
      top = anchor.bottom + GAP;
      left = anchor.left + anchor.width / 2 - box.width / 2;
      break;
    case "left":
      top = anchor.top + anchor.height / 2 - box.height / 2;
      left = anchor.left - box.width - GAP;
      break;
    case "right":
      top = anchor.top + anchor.height / 2 - box.height / 2;
      left = anchor.right + GAP;
      break;
    default:
      top = anchor.top - box.height - GAP;
      left = anchor.left + anchor.width / 2 - box.width / 2;
  }
  if (placement.endsWith("Left")) left = anchor.left;
  if (placement.endsWith("Right")) left = anchor.right - box.width;
  if (placement === "rightTop" || placement === "leftTop") top = anchor.top;
  // Flip when there is no room, then clamp to the viewport.
  if (base === "top" && top < 4) top = anchor.bottom + GAP;
  if (base === "bottom" && top + box.height > vh - 4) top = anchor.top - box.height - GAP;
  if (base === "right" && left + box.width > vw - 4) left = anchor.left - box.width - GAP;
  if (base === "left" && left < 4) left = anchor.right + GAP;
  left = Math.max(4, Math.min(left, vw - box.width - 4));
  top = Math.max(4, Math.min(top, vh - box.height - 4));
  return { top, left };
}

/** Keeps a floating box positioned relative to an anchor while open. */
function useFloating(open: boolean, anchorRef: React.RefObject<HTMLElement>, placement: Placement) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const update = useCallback(() => {
    const a = anchorRef.current;
    const b = boxRef.current;
    if (!a || !b) return;
    setPos(position(a.getBoundingClientRect(), b.getBoundingClientRect(), placement));
  }, [anchorRef, placement]);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, update]);
  return { boxRef, pos };
}

// ---- Tooltip ---------------------------------------------------------------

export const Tooltip: React.FC<{
  title?: React.ReactNode;
  placement?: Placement;
  overlayStyle?: React.CSSProperties;
  children: React.ReactNode;
  block?: boolean;
  /** A click handler an overlay around the tooltip hands it: Popover (and so
   *  Popconfirm) attaches its trigger to its direct child by cloning it with
   *  an onClick. Dropping it left the Cancel button of the results page
   *  dead (bug bash S6-1), so it goes on the anchor. */
  onClick?: React.MouseEventHandler<HTMLSpanElement>;
}> = ({ title, placement = "top", overlayStyle, children, block, onClick }) => {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const { boxRef, pos } = useFloating(open, anchorRef, placement);
  if (title === undefined || title === null || title === "" || title === false) {
    // No tooltip to show, but a handler from an overlay still has to land.
    return onClick ? <span className={cx("tui-anchor", block && "tui-anchor-block")} onClick={onClick}>{children}</span> : <>{children}</>;
  }
  return (
    <>
      <span
        ref={anchorRef}
        className={cx("tui-anchor", block && "tui-anchor-block")}
        // Portal events bubble through the React tree, even though the
        // confirmation is outside this anchor in the DOM. Only the trigger
        // itself should open its tooltip. Dismiss in capture so buttons that
        // stop propagation (e.g. Evaluate in a Collapse header) still hide it.
        onClickCapture={(e) => {
          if (e.currentTarget.contains(e.target as Node)) setOpen(false);
        }}
        onClick={(e) => {
          if (!e.currentTarget.contains(e.target as Node)) return;
          onClick?.(e);
        }}
        onMouseEnter={(e) => {
          if (e.currentTarget.contains(e.target as Node)) setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={(e) => {
          if (e.currentTarget.contains(e.target as Node)) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={boxRef}
            role="tooltip"
            className="tui-tooltip"
            style={{ ...overlayStyle, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
          >
            {title}
          </div>,
          document.body,
        )}
    </>
  );
};

// ---- Popover ---------------------------------------------------------------

type Trigger = "hover" | "click" | "focus";

export const Popover: React.FC<{
  content?: React.ReactNode;
  title?: React.ReactNode;
  trigger?: Trigger | Trigger[];
  placement?: Placement;
  overlayStyle?: React.CSSProperties;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  destroyTooltipOnHide?: boolean;
  children: React.ReactNode;
}> = ({ content, title, trigger = "hover", placement = "top", overlayStyle, open: controlled, onOpenChange, children }) => {
  const triggers = Array.isArray(trigger) ? trigger : [trigger];
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const setOpen = useCallback((v: boolean) => { setInner(v); onOpenChange?.(v); }, [onOpenChange]);
  const { boxRef, pos } = useFloating(open, anchorRef, placement);
  const closeTimer = useRef<number | null>(null);
  const scheduleClose = () => {
    if (!triggers.includes("hover")) return;
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };
  const cancelClose = () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); };

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || boxRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, boxRef]);

  // A click trigger is attached to the child itself (composed with its own
  // handler), not left to bubble: buttons inside collapsible headers stop
  // propagation so the header does not toggle, which would also have
  // stopped the click from ever reaching a wrapper.
  const child =
    triggers.includes("click") && React.isValidElement(children)
      ? React.cloneElement(children as React.ReactElement<any>, {
          onClick: (e: React.MouseEvent) => {
            (children as React.ReactElement<any>).props.onClick?.(e);
            setOpen(!open);
          },
        })
      : children;
  return (
    <>
      <span
        ref={anchorRef}
        className="tui-anchor"
        onMouseEnter={triggers.includes("hover") ? () => { cancelClose(); setOpen(true); } : undefined}
        onMouseLeave={triggers.includes("hover") ? scheduleClose : undefined}
        onFocus={triggers.includes("focus") ? () => setOpen(true) : undefined}
        onBlur={triggers.includes("focus") && !triggers.includes("click") ? () => setOpen(false) : undefined}
        onClick={triggers.includes("click") && !React.isValidElement(children) ? () => setOpen(!open) : undefined}
      >
        {child}
      </span>
      {open &&
        createPortal(
          <div
            ref={boxRef}
            className="tui-popover"
            style={{ ...overlayStyle, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            {title ? <div className="tui-popover-title">{title}</div> : null}
            {content}
          </div>,
          document.body,
        )}
    </>
  );
};

// ---- Popconfirm ------------------------------------------------------------

export const Popconfirm: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
  okText?: string;
  cancelText?: string;
  okButtonProps?: { danger?: boolean; disabled?: boolean; loading?: boolean };
  disabled?: boolean;
  placement?: Placement;
  overlayStyle?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ title, description, onConfirm, onCancel, okText = "OK", cancelText = "Cancel", okButtonProps, disabled, placement = "topRight", overlayStyle, children }) => {
  const [open, setOpen] = useState(false);
  if (disabled) return <>{children}</>;
  return (
    <Popover
      trigger="click"
      placement={placement}
      overlayStyle={overlayStyle}
      open={open}
      onOpenChange={setOpen}
      content={
        <div style={{ maxWidth: 320 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <ExclamationCircleOutlined style={{ color: "var(--color-feedback-default-warning-neutral, #fcc003)", marginTop: 2, flexShrink: 0 }} />
            <div>
              <div className="tui-popover-title" style={{ marginBottom: description ? 4 : 0 }}>{title}</div>
              {description ? <div className="tui-text-secondary">{description}</div> : null}
            </div>
          </div>
          <div className="tui-confirm-actions">
            <Button size="small" onClick={() => { setOpen(false); onCancel?.(); }}>{cancelText}</Button>
            <Button
              size="small"
              type="primary"
              danger={okButtonProps?.danger}
              disabled={okButtonProps?.disabled}
              loading={okButtonProps?.loading}
              onClick={() => { setOpen(false); void onConfirm?.(); }}
            >
              {okText}
            </Button>
          </div>
        </div>
      }
    >
      {children}
    </Popover>
  );
};

// ---- Modal / Drawer ---------------------------------------------------------

/** Sent on the document when a dialog or drawer opens, for anything that
 *  has to step aside for it (the guided tour ends). */
export const OVERLAY_OPEN_EVENT = "tui-overlay-open";

function useEscape(open: boolean, onClose?: () => void) {
  useEffect(() => {
    if (open) document.dispatchEvent(new Event(OVERLAY_OPEN_EVENT));
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
}

export const Modal: React.FC<{
  open: boolean;
  title?: React.ReactNode;
  onCancel?: () => void;
  onOk?: () => void | Promise<void>;
  okText?: string;
  cancelText?: string;
  /** undefined = OK/Cancel buttons; null = no footer. */
  footer?: React.ReactNode | null;
  width?: number | string;
  confirmLoading?: boolean;
  okButtonProps?: { disabled?: boolean; danger?: boolean; style?: React.CSSProperties };
  destroyOnClose?: boolean;
  closable?: boolean;
  children?: React.ReactNode;
}> = ({ open, title, onCancel, onOk, okText = "OK", cancelText = "Cancel", footer, width, confirmLoading, okButtonProps, closable = true, children }) => {
  useEscape(open, onCancel);
  if (!open) return null;
  return createPortal(
    <div className="tui-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}>
      <div className="tui-dialog" role="dialog" aria-modal="true" style={{ maxWidth: width ?? 560 }}>
        {(title || closable) && (
          <div className="tui-dialog-head">
            <span>{title}</span>
            {closable && (
              <button type="button" className="tui-close" aria-label="Close" onClick={onCancel}><CloseOutlined /></button>
            )}
          </div>
        )}
        <div className="tui-dialog-body">{children}</div>
        {footer !== null && (
          <div className="tui-dialog-foot">
            {footer !== undefined ? footer : (
              <>
                <Button onClick={onCancel}>{cancelText}</Button>
                <Button type="primary" danger={okButtonProps?.danger} disabled={okButtonProps?.disabled} loading={confirmLoading} onClick={() => void onOk?.()}>
                  {okText}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export const Drawer: React.FC<{
  open: boolean;
  title?: React.ReactNode;
  onClose?: () => void;
  width?: number | string;
  footer?: React.ReactNode | null;
  placement?: "right" | "left";
  destroyOnClose?: boolean;
  children?: React.ReactNode;
}> = ({ open, title, onClose, width = 480, footer, placement = "right", children }) => {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      <div className="tui-drawer-backdrop" onMouseDown={onClose} />
      <div
        className="tui-drawer"
        role="dialog"
        aria-modal="true"
        style={{ width, ...(placement === "left" ? { left: 0, right: "auto", boxShadow: "4px 0 16px rgba(0,0,0,0.2)" } : {}) }}
      >
        <div className="tui-drawer-head">
          <span>{title}</span>
          <button type="button" className="tui-close" aria-label="Close" onClick={onClose}><CloseOutlined /></button>
        </div>
        <div className="tui-drawer-body">{children}</div>
        {footer ? <div className="tui-drawer-foot">{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
};

// ---- Toasts (message.*) ----------------------------------------------------

type ToastKind = "success" | "error" | "warning" | "info";
interface Toast { id: number; kind: ToastKind; text: React.ReactNode }

let toasts: Toast[] = [];
let listener: ((t: Toast[]) => void) | null = null;
let nextId = 1;
let hostRoot: Root | null = null;
let hostElement: HTMLDivElement | null = null;
const dismissals = new Map<number, () => void>();

const ToastHost: React.FC = () => {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => {
    listener = setItems;
    return () => { listener = null; };
  }, []);
  const Icons: Record<ToastKind, React.FC<any>> = {
    success: CheckCircleFilled, error: CloseCircleFilled, warning: ExclamationCircleOutlined, info: InfoCircleOutlined,
  };
  return (
    <div className="tui-toasts" aria-live="polite">
      {items.map((t) => {
        const Icon = Icons[t.kind];
        return (
          <div key={t.id} className={cx("tui-toast", `tui-toast-${t.kind}`)} role="status">
            <span className="tui-toast-icon"><Icon /></span>
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
};

function ensureHost() {
  if (hostRoot || typeof document === "undefined") return;
  hostElement = document.createElement("div");
  document.body.appendChild(hostElement);
  hostRoot = createRoot(hostElement);
  hostRoot.render(<ToastHost />);
}

function push(kind: ToastKind, text: React.ReactNode, durationSec = 3) {
  ensureHost();
  const id = nextId++;
  toasts = [...toasts, { id, kind, text }];
  listener?.(toasts);
  const timerWindow = window;
  const timer = timerWindow.setTimeout(() => {
    dismissals.delete(id);
    toasts = toasts.filter((t) => t.id !== id);
    listener?.(toasts);
  }, durationSec * 1000);
  dismissals.set(id, () => timerWindow.clearTimeout(timer));
}

export const message = {
  success: (text: React.ReactNode, d?: number) => push("success", text, d),
  error: (text: React.ReactNode, d?: number) => push("error", text, d ?? 5),
  warning: (text: React.ReactNode, d?: number) => push("warning", text, d ?? 4),
  info: (text: React.ReactNode, d?: number) => push("info", text, d),
  /** Dismiss every toast and release its timers and independent React root. */
  destroy: () => {
    for (const cancel of dismissals.values()) cancel();
    dismissals.clear();
    toasts = [];
    hostRoot?.unmount();
    hostRoot = null;
    hostElement?.remove();
    hostElement = null;
    listener = null;
  },
};
