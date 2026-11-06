/**
 * Tableau Design System tokens, as the open-source Tableau UI library
 * (@tableau/tableau-ui) defines them: every value is a CSS variable the
 * library installs on the document (addDesignTokenStylesToDocument) with the
 * same fallback the library itself uses, so a custom element and a library
 * widget next to it are always the same color.
 */

export const tok = (name: string, fallback: string): string => `var(--${name}, ${fallback})`;

export const TDS = {
  font: tok("color-font-default-default", "#2e2e2e"),
  fontSecondary: tok("color-font-default-secondary", "#5c5c5c"),
  fontSubtle: tok("color-font-default-subtle", "#939393"),
  fontHint: tok("color-font-default-hint", "#aeaeae"),
  fontDisabled: tok("color-font-default-disabled", "#c9c9c9"),
  fontError: tok("color-font-default-error", "#ba0517"),
  fontSuccess: tok("color-font-default-success", "#22683e"),
  fontInverse: tok("color-font-inverse-default", "#f3f3f3"),

  surface: tok("color-elevation-surface-default-default", "#FFFFFF"),
  surfaceSubtle: tok("color-elevation-surface-default-subtle", "#f3f3f3"),
  surfaceInverse: tok("color-elevation-surface-inverse-default", "#242424"),
  border: tok("color-elevation-border-default-default", "#c9c9c9"),
  borderSubtle: tok("color-elevation-border-default-subtle", "#e5e5e5"),
  borderMedium: tok("color-elevation-border-default-medium", "#939393"),

  info: tok("color-feedback-default-info", "#05628a"),
  infoLight: tok("color-feedback-default-info-light", "#cfe9fe"),
  notification: tok("color-feedback-default-notification", "#0b5cab"),
  notificationLight: tok("color-feedback-default-notification-light", "#d8e6fe"),
  success: tok("color-feedback-default-success", "#22683e"),
  successLight: tok("color-feedback-default-success-light", "#cdefc4"),
  warning: tok("color-feedback-default-warning", "#6f3400"),
  warningNeutral: tok("color-feedback-default-warning-neutral", "#fcc003"),
  warningLight: tok("color-feedback-default-warning-light", "#f9e3b6"),
  error: tok("color-feedback-default-error", "#ba0517"),
  errorLight: tok("color-feedback-default-error-light", "#feded8"),
  neutral: tok("color-feedback-default-neutral", "#444444"),
  neutralLight: tok("color-feedback-default-neutral-light", "#e5e5e5"),

  /** Action blue used by the library's primary button and links. */
  primary: tok("color-feedback-default-info", "#05628a"),
  danger: tok("color-feedback-default-error", "#ba0517"),
} as const;
