/**
 * The UI kit: the open-source Tableau UI library (@tableau/tableau-ui) plus
 * the pieces it does not ship, all drawn with its design tokens. Pages import
 * from here and from ./icons; nothing else brings a component library in.
 */

export * from "./basics";
export * from "./overlays";
export * from "./Table";
export * from "./Form";
export * from "./Collapse";
export { TDS, tok } from "./tokens";
export { addDesignTokenStylesToDocument } from "@tableau/tableau-ui";
