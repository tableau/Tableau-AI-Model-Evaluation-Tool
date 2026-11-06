/**
 * Compatibility names for the design tokens (src/ui/tokens.ts) under the
 * keys the pages were written against. Every value is a CSS variable the
 * open-source Tableau UI library defines, with its own fallback.
 */

import { TDS as T } from "./ui/tokens";

export const TDS = {
  primary: T.primary,
  primaryHover: T.info,
  primaryActive: T.info,
  danger: T.danger,
  success: T.success,
  warning: T.warningNeutral,
  info: T.info,
  infoBg: T.infoLight,
  textPrimary: T.font,
  textSecondary: T.fontSecondary,
  textTertiary: T.fontSubtle,
  border: T.borderSubtle,
  borderStrong: T.border,
  surface: T.surface,
  surfaceSecondary: T.surfaceSubtle,
  surfaceTertiary: T.surfaceSubtle,
  font: "'Libre Franklin', 'Benton Sans', 'Helvetica Neue', Arial, sans-serif",
  mono: "Menlo, Consolas, 'Courier New', monospace",
};
