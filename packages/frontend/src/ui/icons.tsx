/**
 * The icon set the pages use, as inline SVG (stroke icons, 1em). Named after
 * the Ant Design icons they replace so the pages' imports only change path;
 * the drawings are simple line glyphs in the Tableau UI idiom.
 */

import React from "react";

export interface IconProps extends React.SVGAttributes<SVGElement> {
  spin?: boolean;
}

const make = (
  body: React.ReactNode,
  opts: { filled?: boolean; viewBox?: string; stroke?: boolean } = {},
): React.FC<IconProps> => {
  const stroke = opts.stroke ?? true;
  const Icon: React.FC<IconProps> = ({ spin, className, style, ...rest }) => (
    <svg
      width="1em"
      height="1em"
      viewBox={opts.viewBox ?? "0 0 24 24"}
      fill={opts.filled ? "currentColor" : "none"}
      stroke={stroke ? "currentColor" : "none"}
      strokeWidth={stroke ? 2 : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rest["aria-label"] ? undefined : true}
      focusable="false"
      className={[spin ? "tui-spin" : "", className || ""].join(" ").trim() || undefined}
      style={{ verticalAlign: "-0.125em", flexShrink: 0, ...style }}
      {...rest}
    >
      {body}
    </svg>
  );
  return Icon;
};

export const ArrowRightOutlined = make(<><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>);
export const ArrowLeftOutlined = make(<><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>);
export const LeftOutlined = make(<polyline points="15 18 9 12 15 6" />);
export const RightOutlined = make(<polyline points="9 18 15 12 9 6" />);
export const StepBackwardOutlined = make(<><line x1="6" y1="6" x2="6" y2="18" /><polyline points="18 18 12 12 18 6" /></>);
export const StepForwardOutlined = make(<><polyline points="6 18 12 12 6 6" /><line x1="18" y1="6" x2="18" y2="18" /></>);
export const DownOutlined = make(<polyline points="6 9 12 15 18 9" />);
export const ExpandAllOutlined = make(<><polyline points="6 5 12 11 18 5" /><polyline points="6 13 12 19 18 13" /></>);
export const CollapseAllOutlined = make(<><polyline points="6 11 12 5 18 11" /><polyline points="6 19 12 13 18 19" /></>);
export const UpOutlined = make(<polyline points="6 15 12 9 18 15" />);
export const RedoOutlined = make(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><polyline points="21 3 21 9 15 9" /></>);
export const CaretRightOutlined = make(<polygon points="7 4 20 12 7 20 7 4" fill="currentColor" stroke="none" />);
export const CheckOutlined = make(<polyline points="20 6 9 17 4 12" />);
export const CloseOutlined = make(<><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>);
export const DeleteOutlined = make(<><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></>);
export const PauseOutlined = make(<><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>);
export const StopOutlined = make(<rect x="5" y="5" width="14" height="14" rx="1" />);
export const QuestionCircleOutlined = make(<><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></>);
export const InfoCircleOutlined = make(<><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>);
export const ExclamationCircleOutlined = make(<><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>);
export const SettingOutlined = make(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>);
export const HistoryOutlined = make(<><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /><polyline points="12 7 12 12 15 14" /></>);
export const MenuFoldOutlined = make(<><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="14" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /><polyline points="21 9 18 12 21 15" /></>);
export const ClockCircleOutlined = make(<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>);
export const MinusCircleOutlined = make(<><circle cx="12" cy="12" r="10" /><line x1="8" y1="12" x2="16" y2="12" /></>);
export const CheckCircleFilled = make(<><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" /><polyline points="16.5 9 10.5 15 7.5 12" stroke="#fff" /></>);
export const CloseCircleFilled = make(<><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" /><line x1="15" y1="9" x2="9" y2="15" stroke="#fff" /><line x1="9" y1="9" x2="15" y2="15" stroke="#fff" /></>);
export const PauseCircleFilled = make(<><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" /><line x1="10" y1="9" x2="10" y2="15" stroke="#fff" /><line x1="14" y1="9" x2="14" y2="15" stroke="#fff" /></>);
export const LoadingOutlined: React.FC<IconProps> = (props) => {
  const Arc = make(<path d="M21 12a9 9 0 1 1-6.22-8.56" />);
  return <Arc spin {...props} />;
};
export const DiffOutlined = make(<><line x1="12" y1="3" x2="12" y2="9" /><line x1="9" y1="6" x2="15" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="15" y2="18" /></>);
export const UploadOutlined = make(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>);
export const DownloadOutlined = make(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>);
export const SearchOutlined = make(<><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>);
export const EyeOutlined = make(<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>);
export const EyeInvisibleOutlined = make(<><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>);

export const SparklesIcon = make(
  <>
    <path d="M10.806 1.117c.069-.156.319-.156.388 0 .15.34.378.779.644 1.045.266.266.705.494 1.045.644.156.069.156.319 0 .388-.34.15-.779.378-1.045.644-.266.266-.494.705-.644 1.045-.069.156-.319.156-.388 0-.15-.34-.378-.779-.644-1.045-.266-.266-.705-.494-1.045-.644-.156-.069-.156-.319 0-.388.34-.15.779-.378 1.045-.644.266-.266.494-.705.644-1.045ZM10.806 9.117c.069-.156.319-.156.388 0 .15.34.378.779.644 1.045.266.266.705.494 1.045.644.156.069.156.319 0 .388-.34.15-.779.378-1.045.644-.266.266-.494.705-.644 1.045-.069.156-.319.156-.388 0-.15-.34-.378-.779-.644-1.045-.266-.266-.705-.494-1.045-.644-.156-.069-.156-.319 0-.388.34-.15.779-.378 1.045-.644.266-.266.494-.705.644-1.045Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4.939 2.828c.202-.437.92-.437 1.122 0 .35.754.839 1.647 1.401 2.21.563.562 1.456 1.051 2.21 1.4.437.203.437.92 0 1.123-.754.35-1.647.839-2.21 1.401-.562.563-1.051 1.456-1.4 2.21-.203.437-.92.437-1.123 0-.35-.754-.839-1.647-1.401-2.21-.563-.562-1.456-1.051-2.21-1.4-.437-.203-.437-.92 0-1.123.754-.35 1.647-.839 2.21-1.401.562-.563 1.051-1.456 1.4-2.21ZM4.25 5.751c.496-.496.918-1.163 1.249-1.784.33.621.753 1.288 1.249 1.784.496.496 1.163.918 1.784 1.249-.621.33-1.288.753-1.784 1.249-.496.496-.918 1.163-1.249 1.784-.33-.621-.753-1.288-1.249-1.784C3.755 7.753 3.088 7.33 2.467 7c.621-.33 1.288-.753 1.784-1.249Z"
    />
  </>,
  { filled: true, stroke: false, viewBox: "0 0 14 14" },
);
