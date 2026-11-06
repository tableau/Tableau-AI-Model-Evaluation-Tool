/**
 * Tableau calculation syntax and semantic validation.
 *
 * Two-phase validation:
 *   1. static (syntax)  -> parser.ts
 *   2. dynamic (semantic) -> dynamic_validator.ts
 *
 * validate(formula) => { isValid, errors }. On a syntax error we short-circuit
 * with a single "Syntax Error: ..." message (mirroring _run_static_validation).
 */
import { parse } from "./parser.ts";
import { DynamicValidator } from "./dynamic_validator.ts";
import { FUNCTION_TYPES } from "./function_types.ts";

const LINE_COMMENT = /\/\/[^\r\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * A formula as the grammar expects it: comments removed and every line break
 * or tab turned into a space. Tableau ignores line breaks, but the
 * grammar keeps them as tokens, so a formula written over several lines (every
 * CASE a model writes) parsed into the wrong tree there.; the port's lexer already skips whitespace, but the
 * normalisation is kept so blank/comment-only formulas read "Empty formula".
 */
export function normalizeFormula(formula: unknown): string {
  if (formula === null || formula === undefined) return "";
  let text = String(formula).replace(BLOCK_COMMENT, " ");
  text = text.replace(LINE_COMMENT, " ");
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export class TableauValidator {
  private validColumns: Record<string, string>;
  private functionType: Record<string, string>;

  constructor(
    validColumns: Record<string, string>,
    functionType: Record<string, string> = FUNCTION_TYPES,
  ) {
    this.validColumns = validColumns;
    this.functionType = functionType;
  }

  validate(rawFormula: string): ValidationResult {
    const formula = normalizeFormula(rawFormula);
    if (!formula) return { isValid: false, errors: ["Empty formula"] };
    // static (syntax) validation
    const parsed = parse(formula);
    if (!parsed.ok || parsed.tree === null) {
      return { isValid: false, errors: [`Syntax Error: ${parsed.error}`] };
    }

    // dynamic (semantic) validation
    const dynamic = new DynamicValidator(this.validColumns, this.functionType);
    const errors = dynamic.validate(parsed.tree);
    if (errors.length > 0) {
      return { isValid: false, errors };
    }
    return { isValid: true, errors: [] };
  }
}
