/**
 * Basic components of the UI kit, built on the open-source Tableau UI
 * library (@tableau/tableau-ui) where it has the widget, and on the same
 * design tokens (ui.css) where it does not. Prop names follow the pages'
 * existing usage so a page switches libraries by changing an import.
 */

import React, { forwardRef, useMemo } from "react";
import * as TUI from "@tableau/tableau-ui";
import {
  CheckCircleFilled, CloseCircleFilled, CloseOutlined, ExclamationCircleOutlined,
  InfoCircleOutlined, LoadingOutlined,
} from "./icons";

const cx = (...parts: Array<string | number | false | null | undefined>) =>
  parts.filter(Boolean).join(" ") || undefined;

// ---- Button ----------------------------------------------------------------

export type ButtonType = "primary" | "default" | "text" | "link" | "dashed";

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  type?: ButtonType;
  htmlType?: "button" | "submit" | "reset";
  danger?: boolean;
  size?: "small" | "middle" | "large";
  icon?: React.ReactNode;
  loading?: boolean;
  /** Renders an anchor styled as an outline button (downloads, external links). */
  href?: string;
  download?: boolean | string;
  target?: string;
  rel?: string;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { type = "default", htmlType = "button", danger, size, icon, loading, href, download, target, rel,
    block, children, className, style, disabled, ...rest },
  ref,
) {
  const content = (
    <span className="tui-btn-content">
      {loading ? <LoadingOutlined /> : icon}
      {children != null && children !== false ? <span>{children}</span> : null}
    </span>
  );
  if (href) {
    return (
      <a
        className={cx("tui-btn-link-outline", size === "small" && "tui-small", className)}
        href={disabled ? undefined : href}
        download={download as any}
        target={target}
        rel={rel}
        aria-disabled={disabled ? "true" : undefined}
        style={style}
        onClick={rest.onClick as any}
        aria-label={rest["aria-label"]}
      >
        {content}
      </a>
    );
  }
  if (type === "link") {
    return (
      <button
        ref={ref}
        type={htmlType}
        className={cx("tui-link", className)}
        style={style}
        disabled={disabled || loading}
        {...rest}
      >
        {content}
      </button>
    );
  }
  const kind: TUI.ButtonProps["kind"] =
    type === "primary" ? (danger ? "destructive" : "primary")
    : type === "text" ? (danger ? "attentionRed" : "lowEmphasis")
    : danger ? "attentionRed"
    : "outline";
  // Call sites used to force the brand blue with inline colors over the
  // previous library's button; the library's own primary is the brand
  // color now, so those overrides are dropped rather than painted over it.
  const { backgroundColor, borderColor, color, ...safeStyle } = (style || {}) as React.CSSProperties;
  const kept = kind === "outline" || kind === "lowEmphasis" ? { ...safeStyle, color } : safeStyle;
  return (
    <TUI.Button
      ref={ref}
      type={htmlType}
      kind={kind}
      density={size === "small" ? "high" : "medium"}
      className={cx(!children && icon && "tui-btn-icon-only", className)}
      style={block ? { ...kept, width: "100%" } : kept}
      disabled={disabled || loading}
      {...rest}
    >
      {content}
    </TUI.Button>
  );
});

// ---- Tag (Sticker) ---------------------------------------------------------

const STICKER_BY_COLOR: Record<string, TUI.StickerProps["stickerType"]> = {
  success: "green", green: "green", lime: "green",
  error: "red", red: "red", volcano: "red", magenta: "red",
  warning: "yellow", gold: "yellow", orange: "yellow",
  processing: "blue", blue: "blue", geekblue: "blue", cyan: "teal", teal: "teal",
  purple: "violet", violet: "violet",
  default: "neutral",
};

export const Tag: React.FC<{
  color?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  title?: string;
}> = ({ color, children, style, className, title }) => (
  <TUI.Sticker
    stickerType={(color && STICKER_BY_COLOR[color]) || "neutral"}
    className={className}
    style={{ marginRight: 4, ...style }}
    title={title}
  >
    <span className="tui-tag-content">{children}</span>
  </TUI.Sticker>
);

/** A deterministic color name for a label (suite capability, diff label). */
const LABEL_COLORS = ["blue", "green", "purple", "orange", "teal", "red", "gold", "geekblue", "cyan", "magenta"];
export const getColorForLabel = (label: string): string => {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return LABEL_COLORS[hash % LABEL_COLORS.length];
};

// ---- Alert -----------------------------------------------------------------

export const Alert: React.FC<{
  type?: "info" | "success" | "warning" | "error";
  message: React.ReactNode;
  description?: React.ReactNode;
  showIcon?: boolean;
  closable?: boolean;
  action?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  onClose?: () => void;
}> = ({ type = "info", message, description, showIcon = true, closable, action, style, className, onClose }) => {
  const [closed, setClosed] = React.useState(false);
  if (closed) return null;
  const Icon =
    type === "success" ? CheckCircleFilled
    : type === "error" ? CloseCircleFilled
    : type === "warning" ? ExclamationCircleOutlined
    : InfoCircleOutlined;
  return (
    <div className={cx("tui-alert", `tui-alert-${type}`, className)} style={style} role={type === "error" ? "alert" : "status"}>
      {showIcon && <span className="tui-alert-icon"><Icon /></span>}
      <div className="tui-alert-body">
        <div className="tui-alert-message">{message}</div>
        {description ? <div className="tui-alert-description">{description}</div> : null}
      </div>
      {action ? <div>{action}</div> : null}
      {closable && (
        <button
          type="button"
          className="tui-alert-close"
          aria-label="Close"
          onClick={() => { setClosed(true); onClose?.(); }}
        >
          <CloseOutlined />
        </button>
      )}
    </div>
  );
};

// ---- Card ------------------------------------------------------------------

export const Card: React.FC<{
  title?: React.ReactNode;
  extra?: React.ReactNode;
  size?: "small" | "default";
  type?: "inner";
  loading?: boolean;
  style?: React.CSSProperties;
  className?: string;
  bodyStyle?: React.CSSProperties;
  styles?: { body?: React.CSSProperties; header?: React.CSSProperties };
  children?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}> = ({ title, extra, size, type, loading, style, className, bodyStyle, styles, children, onClick }) => (
  <div
    className={cx("tui-card", size === "small" && "tui-card-small", type === "inner" && "tui-card-inner", className)}
    style={style}
    onClick={onClick}
  >
    {(title || extra) && (
      <div className="tui-card-head" style={styles?.header}>
        <span>{title}</span>
        {extra ? <span>{extra}</span> : null}
      </div>
    )}
    <div className="tui-card-body" style={{ ...bodyStyle, ...styles?.body }}>
      {loading ? <Skeleton active paragraph={{ rows: 2 }} /> : children}
    </div>
  </div>
);

// ---- Space / Divider -------------------------------------------------------

const SPACE_SIZES: Record<string, number> = { small: 8, middle: 16, large: 24 };

export const Space: React.FC<{
  size?: number | "small" | "middle" | "large";
  direction?: "horizontal" | "vertical";
  wrap?: boolean;
  align?: "start" | "center" | "end" | "baseline";
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
}> = ({ size = 8, direction = "horizontal", wrap, align, style, className, children }) => (
  <span
    className={cx(direction === "vertical" ? "tui-space-vertical" : "tui-space", wrap && "tui-space-wrap", className)}
    style={{
      gap: typeof size === "number" ? size : SPACE_SIZES[size],
      alignItems: align === "start" ? "flex-start" : align === "end" ? "flex-end" : align,
      ...style,
    }}
  >
    {children}
  </span>
);

export const Divider: React.FC<{
  children?: React.ReactNode;
  type?: "horizontal" | "vertical";
  style?: React.CSSProperties;
  className?: string;
}> = ({ children, type = "horizontal", style, className }) => {
  if (type === "vertical") {
    return <span className={className} style={{ display: "inline-block", width: 1, height: "1em", background: "var(--color-elevation-border-default-subtle, #e5e5e5)", margin: "0 8px", verticalAlign: "middle", ...style }} />;
  }
  if (children) {
    return <div className={cx("tui-divider-text", className)} style={style}><span>{children}</span></div>;
  }
  return <hr className={cx("tui-divider", className)} style={style} />;
};

// ---- Typography ------------------------------------------------------------

export interface TextProps extends React.HTMLAttributes<HTMLSpanElement> {
  type?: "secondary" | "warning" | "danger" | "success";
  strong?: boolean;
  code?: boolean;
  ellipsis?: boolean | { rows?: number; tooltip?: unknown };
}

export const Text: React.FC<TextProps> = ({ type, strong, code, ellipsis, className, style, children, ...rest }) => {
  const rows = typeof ellipsis === "object" ? ellipsis.rows : undefined;
  return (
    <span
      className={cx(
        "tui-text",
        type === "secondary" && "tui-text-secondary",
        type === "warning" && "tui-text-warning",
        type === "danger" && "tui-text-danger",
        type === "success" && "tui-text-success",
        strong && "tui-text-strong",
        code && "tui-text-code",
        ellipsis && !rows && "tui-text-ellipsis",
        rows && "tui-clamp",
        className,
      )}
      style={rows ? { WebkitLineClamp: rows, ...style } : style}
      {...rest}
    >
      {children}
    </span>
  );
};

export const Title: React.FC<{ level?: 1 | 2 | 3 | 4 | 5; style?: React.CSSProperties; className?: string; children?: React.ReactNode }> = ({ level = 1, style, className, children }) => {
  const TagName = (`h${Math.min(level, 4)}` as unknown) as React.ElementType;
  return <Tagname_ Tagname={TagName} className={cx("tui-title", `tui-title-${Math.min(level, 4)}`, className)} style={style}>{children}</Tagname_>;
};
// Small indirection so the heading level is a plain element type.
const Tagname_: React.FC<{ Tagname: React.ElementType; className?: string; style?: React.CSSProperties; children?: React.ReactNode }> = ({ Tagname, ...p }) => <Tagname {...p} />;

export const Paragraph: React.FC<{
  ellipsis?: { rows?: number; expandable?: boolean; symbol?: string };
  type?: TextProps["type"];
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
}> = ({ ellipsis, type, style, className, children }) => {
  const [open, setOpen] = React.useState(false);
  const rows = ellipsis?.rows;
  return (
    <div className={cx("tui-paragraph", type === "secondary" && "tui-text-secondary", className)} style={style}>
      <div className={rows && !open ? "tui-clamp" : undefined} style={rows && !open ? { WebkitLineClamp: rows } : undefined}>
        {children}
      </div>
      {rows && ellipsis?.expandable && (
        <button type="button" className="tui-link" style={{ fontSize: 12 }} onClick={() => setOpen(!open)}>
          {open ? "less" : ellipsis.symbol || "more"}
        </button>
      )}
    </div>
  );
};

export const Typography = { Text, Title, Paragraph };

// ---- Form controls ---------------------------------------------------------

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  prefix?: React.ReactNode;
  allowClear?: boolean;
  size?: "small" | "middle" | "large";
  onPressEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const InputBase = forwardRef<HTMLInputElement, InputProps>(function Input(
  { prefix, allowClear, size, style, className, onPressEnter, onKeyDown, onChange, value, ...rest },
  ref,
) {
  const field = (
    <TUI.TextField
      ref={ref}
      kind="outline"
      className={className}
      style={{ width: "100%", boxSizing: "border-box", ...(prefix ? { paddingLeft: 28 } : {}), ...(size === "small" ? { height: 28 } : {}) }}
      value={value ?? ""}
      onChange={onChange}
      onClear={allowClear && onChange ? () => onChange({ target: { value: "" } } as any) : undefined}
      onKeyDown={(e) => { onKeyDown?.(e); if (e.key === "Enter") onPressEnter?.(e); }}
      {...rest}
    />
  );
  if (!prefix) return <span className="tui-input-wrap" style={style}>{field}</span>;
  return (
    <span className="tui-input-wrap" style={style}>
      <span className="tui-input-prefix">{prefix}</span>
      {field}
    </span>
  );
});

const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function Password(props, ref) {
  return <InputBase ref={ref} type="password" autoComplete="off" {...props} />;
});

export const Input = Object.assign(InputBase, { Password: PasswordInput });

export interface SelectOption { value: string; label: React.ReactNode; disabled?: boolean }

export const Select: React.FC<{
  value?: string | null;
  onChange?: (value: any) => void;
  options?: SelectOption[];
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  size?: "small" | "middle" | "large";
  style?: React.CSSProperties;
  className?: string;
  "aria-label"?: string;
  id?: string;
}> = ({ value, onChange, options = [], placeholder, allowClear, disabled, size, style, className, id, ...aria }) => (
  <span className={cx("tui-select-wrap", size === "small" && "tui-select-wrap-small")} style={style}>
  <TUI.DropdownSelect
    kind="outline"
    id={id}
    className={className}
    disabled={disabled}
    aria-label={aria["aria-label"]}
    style={{ width: "100%", boxSizing: "border-box", height: "100%" }}
    value={value ?? ""}
    onChange={(e) => {
      const v = e.target.value;
      onChange?.(v === "" ? (allowClear ? null : v) : v);
    }}
  >
    {(placeholder || allowClear || value == null) && (
      <option value="">{placeholder || ""}</option>
    )}
    {options.map((o) => (
      <option key={o.value} value={o.value} disabled={o.disabled}>
        {typeof o.label === "string" ? o.label : String(o.value)}
      </option>
    ))}
  </TUI.DropdownSelect>
  </span>
);

export const Checkbox: React.FC<{
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  "aria-label"?: string;
}> = ({ checked, indeterminate, disabled, onChange, children, style, className, ...aria }) => (
  <TUI.Checkbox
    checked={!!checked}
    indeterminate={indeterminate}
    disabled={disabled}
    onChange={onChange}
    style={style}
    className={className}
    aria-label={aria["aria-label"]}
  >
    {children}
  </TUI.Checkbox>
);

export const Switch: React.FC<{
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  checkedChildren?: React.ReactNode;
  unCheckedChildren?: React.ReactNode;
  style?: React.CSSProperties;
  "aria-label"?: string;
}> = ({ checked, onChange, disabled, style, ...aria }) => (
  <TUI.ToggleSwitch
    checked={!!checked}
    disabled={disabled}
    onChange={(e) => onChange?.(e.target.checked)}
    style={style}
    aria-label={aria["aria-label"]}
  />
);

export const Progress: React.FC<{
  percent?: number;
  status?: "active" | "success" | "exception" | "normal";
  showInfo?: boolean;
  /** What is progressing, shown on the line above the bar (the percentage,
   *  when shown, sits at the right end of that line). */
  label?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}> = ({ percent = 0, status, showInfo = true, label, style, className }) => (
  // The library's bar sizes to its content; the wrapper makes it a block
  // that fills whatever it is put in.
  <div className={cx("tui-progress", !label && !showInfo && "tui-progress-bare", className)} style={style}>
    <TUI.ProgressBar
      value={Math.max(0, Math.min(100, percent))}
      max={100}
      kind={status === "exception" ? "error" : status === "success" ? "success" : "default"}
      label={label as any}
      valueText={showInfo ? `${Math.round(percent)}%` : ""}
      aria-label={label ? undefined : "Progress"}
    />
  </div>
);

export const Skeleton: React.FC<{
  active?: boolean;
  title?: boolean;
  paragraph?: boolean | { rows?: number };
  style?: React.CSSProperties;
}> = ({ active, title = true, paragraph = true, style }) => {
  const rows = typeof paragraph === "object" ? paragraph.rows ?? 3 : paragraph ? 3 : 0;
  return (
    <div className={cx(active && "tui-skeleton-active")} style={style} aria-busy="true">
      {title && <div className="tui-skeleton-line" style={{ width: "40%" }} />}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="tui-skeleton-line" style={{ width: i === rows - 1 ? "60%" : "100%" }} />
      ))}
    </div>
  );
};

export const Spin: React.FC<{ size?: "small" | "default" | "large"; style?: React.CSSProperties }> = ({ size, style }) => (
  <TUI.Spinner alt="Loading" dimension={size === "large" ? 32 : size === "small" ? 16 : 24} style={style} />
);

/** Memoised classnames helper for the other kit modules. */
export const useCx = () => useMemo(() => cx, []);
export { cx };
