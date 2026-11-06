/**
 * Checks a Tableau Prep calculation, and compares it with the expected one.
 * Uses the checked-in Prep grammar and function catalog.
 *
 * The bench's grammar (`TableauExpression.g4`) was written for an editor: it
 * accepts unfinished formulas (an IF without END, a function call without
 * its closing bracket) through rules named *Incomplete / *Missing*, so that a
 * parse never fails while the user is still typing. This module listens to
 * the lexer, walks the tree for the incomplete rules, checks function names
 * against the reference the prompt gives the model and field names against
 * the fields the case gives it, and reports every problem in plain words.
 *
 * The grammar in `grammar/TableauExpression.g4` generates the lexer/parser
 * with Java-free antlr-ng (scripts/generate-prep-parser.ts). Generated output
 * is checked in and refreshed when its inputs change, just like the separate
 * Calculated fields grammar in `validator/grammar/`.
 *
 * It also compares two formulas token by token (`formulaSimilarity`), so that
 * letter case of functions and keywords, spacing, comments and the quote style
 * of text do not count as differences.
 */

import {
  BaseErrorListener,
  CharStream,
  CommonTokenStream,
  ParserRuleContext,
  TerminalNode,
  type ATNSimulator,
  type ParseTree,
  type Recognizer,
  type Token,
} from "antlr4ng";
import { TableauExpressionLexer } from "./generated/TableauExpressionLexer.ts";
import { TableauExpressionParser } from "./generated/TableauExpressionParser.ts";
import { SequenceMatcher } from "./sequence_matcher.ts";

/**
 * The Tableau Prep functions a generated calculation may use: the reference
 * list the Prep calculation prompt gives the model.
 */
export const PREP_FUNCTIONS: ReadonlySet<string> = new Set(
  `ABS ACOS ASCII ASIN ATAN ATAN2 AVG CEILING CHAR CONTAINS COS COT COUNT COUNTD
DATE DATEADD DATEDIFF DATENAME DATEPARSE DATEPART DATETIME DATETRUNC DAY
DEGREES DIV ENDSWITH EXP FIND FINDNTH FLOAT FLOOR HEXBINX HEXBINY IFNULL IIF
INT ISDATE ISNULL LAST_VALUE LEFT LEN LN LOG LOOKUP LOWER LTRIM MAKEDATE
MAKEDATETIME MAKETIME MAX MEDIAN MID MIN MONTH NOW NTILE PERCENTILE PI POWER
PROPER RADIANS RANK RANK_DENSE RANK_MODIFIED RANK_PERCENTILE REGEXP_EXTRACT
REGEXP_EXTRACT_NTH REGEXP_MATCH REGEXP_REPLACE REPLACE RIGHT ROUND ROW_NUMBER
RTRIM RUNNING_AVG RUNNING_SUM SIGN SIN SPACE SPLIT SQRT SQUARE STARTSWITH
STDEV STDEVP STR SUM TAN TODAY TRIM UPPER VAR VARP YEAR ZN`.split(/\s+/),
);

export const EMPTY_FORMULA = "Empty formula";

/**
 * The grammar's incomplete-construct rules, in words. A rule not listed here
 * is worded from its name ("caseStatementIncomplete" -> "CASE left unfinished").
 */
const INCOMPLETE_WORDS: Record<string, string> = {
  ifStatementMissingEnd: "IF without END",
  ifStatementMissingThen: "IF without THEN",
  ifStatementMissingCondition: "IF without a condition",
  ifStatementMissingThenExpression: "THEN without a value",
  ifStatementMissingElseExpression: "ELSE without a value",
  ifStatementMissingElseIf: "ELSEIF left unfinished",
  ifStatementMissingElseIfCondition: "ELSEIF without a condition",
  ifStatementMissingElseIfThen: "ELSEIF without THEN",
  ifStatementMissingElseIfThenExpression: "ELSEIF THEN without a value",
  caseStatementMissingEnd: "CASE without END",
  caseStatementMissingWhen: "CASE without WHEN",
  caseStatementMissingCaseExpression: "CASE without a value to compare",
  caseStatementMissingWhenExpression: "WHEN without a value",
  caseStatementMissingThen: "WHEN without THEN",
  caseStatementMissingThenExpression: "THEN without a value",
  lodStatementMissingColon: "Level-of-detail expression without the colon after its dimensions",
  lodStatementMissingRightBracket: "Level-of-detail expression without its closing }",
  lodStatementMissingLeftBracket: "Level-of-detail expression without its opening {",
  lodStatementMissingBrackets: "Level-of-detail expression without its { }",
  lodStatementMissingFixed: "Level-of-detail expression without FIXED, PARTITION or ORDERBY",
  lodStatementUnsupported: "Level-of-detail expression of a kind Tableau Prep does not support",
  functionCallMissingCloseParen: "Function call without its closing bracket",
  fieldReferenceIncomplete: "Field name without its closing ]",
  stringLiteralIncomplete: "Text without its closing quote",
  dateLiteralIncomplete: "Date without its closing #",
  orderbyExpressionIncomplete: "ORDERBY left unfinished",
  partitionExpressionIncomplete: "PARTITION left unfinished",
};
/** Wrapper rules that always fire beside a specific one; reported only alone. */
const GENERIC_INCOMPLETE = new Set([
  "ifStatementIncomplete",
  "caseStatementIncomplete",
  "lodStatementIncomplete",
  "functionCallIncomplete",
  "literalIncomplete",
]);
const RULE_NAMES = TableauExpressionParser.ruleNames;
const INCOMPLETE_RULES = new Set(RULE_NAMES.filter((n) => /Incomplete|Missing|Unsupported/.test(n)));
const FUNCTION_RULES = new Set(["functionCall", "functionCallMissingCloseParen"]);
const FIELD_RULES = new Set(["fieldReference"]);

/**
 * The field names a case gives the model, from its field-metadata line
 * ("'Region' (string), 'Profit' (int)"). Null when the line names none.
 */
export function parseFieldMetadata(text: unknown): Set<string> | null {
  if (typeof text !== "string") return null;
  const names = new Set([...text.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
  return names.size ? names : null;
}

function wordsFor(rule: string): string {
  if (rule in INCOMPLETE_WORDS) return INCOMPLETE_WORDS[rule]!;
  const construct = rule.replace(/(Statement)?(Incomplete|Missing.*|Unsupported)$/, "");
  const named: Record<string, string> = {
    if: "IF",
    case: "CASE",
    lod: "Level-of-detail expression",
    functionCall: "Function call",
    literal: "Value",
  };
  return `${named[construct] ?? construct} left unfinished`;
}

type ParserError = [line: number, column: number, symbol: string | null, msg: string];

class Listener extends BaseErrorListener {
  readonly lexer: string[] = [];
  readonly parser: ParserError[] = [];
  override syntaxError<S extends Token, T extends ATNSimulator>(
    _recognizer: Recognizer<T>,
    offendingSymbol: S | null,
    line: number,
    column: number,
    msg: string,
  ): void {
    if (offendingSymbol === null || offendingSymbol === undefined) {
      // A character no token starts with: "token recognition error at: '`'"
      const m = /at: '(.*)'$/s.exec(msg);
      this.lexer.push(m ? m[1]! : msg);
    } else {
      this.parser.push([line, column, offendingSymbol.text ?? null, msg]);
    }
  }
}

function plainParserError(line: number, column: number, symbol: string | null, msg: string): string {
  const where = `at character ${column + 1}` + (line > 1 ? ` of line ${line}` : "");
  if (symbol === "<EOF>" || msg.split("expecting")[0]!.includes("<EOF>")) {
    return `The formula ends before it is complete (${where})`;
  }
  if (msg.startsWith("no viable alternative")) {
    const m = /at input '(.*)'$/s.exec(msg);
    const seen = m ? ` after '${m[1]}'` : "";
    return `Cannot read the formula ${where}${seen}`;
  }
  if (symbol !== null) return `Unexpected '${symbol}' ${where}`;
  return msg.replace(/\s+expecting\s+[\s\S]*$/, "");
}

interface Walk {
  incomplete: string[];
  functions: string[];
  fields: string[];
}

/** A pre-order parse-tree walk: enter every rule, pre-order. */
function walk(node: ParseTree, out: Walk): void {
  if (!(node instanceof ParserRuleContext)) return;
  const rule = RULE_NAMES[node.ruleIndex]!;
  if (INCOMPLETE_RULES.has(rule)) {
    out.incomplete.push(rule);
  } else if (FUNCTION_RULES.has(rule)) {
    const leaf = node.children.find((c) => c instanceof TerminalNode);
    if (leaf) out.functions.push(leaf.getText());
  } else if (FIELD_RULES.has(rule)) {
    out.fields.push(node.getText());
  }
  for (const child of node.children) walk(child, out);
}

/**
 * Every problem with a formula, in plain words. An empty list means a valid
 * formula. `fields`: the names the model was given; null skips the field check.
 */
export function checkCalc(formula: unknown, fields: Set<string> | null = null): string[] {
  if (typeof formula !== "string" || !formula.trim()) return [EMPTY_FORMULA];
  // Block comments are valid Tableau; the grammar only knows // comments.
  let text = formula.replace(/\/\*[\s\S]*?\*\//g, " ");
  const left = `(\\[[^\\]]+\\]|'[^']*'|"[^"]*"|\\w+(?:\\([^()]*\\))?)`;
  const inList = new RegExp(`${left}\\s+IN\\s*\\(([^()]*)\\)`, "gi");
  let previous: string;
  do {
    previous = text;
    text = text.replace(inList, (match, lhs: string, values: string) => {
      const entries = values.split(",").map(v => v.trim()).filter(Boolean);
      return entries.length ? `(${entries.map(v => `${lhs} = ${v}`).join(" OR ")})` : match;
    });
  } while (previous !== text);
  text = text.replace(new RegExp(`${left}\\s+IN\\s*(\\[[^\\]]+\\])`, "gi"), "$1 = $2");

  const listener = new Listener();
  const lexer = new TableauExpressionLexer(CharStream.fromString(text));
  lexer.removeErrorListeners();
  lexer.addErrorListener(listener);
  const parser = new TableauExpressionParser(new CommonTokenStream(lexer));
  parser.removeErrorListeners();
  parser.addErrorListener(listener);
  const tree = parser.expressionEOF();
  const walked: Walk = { incomplete: [], functions: [], fields: [] };
  walk(tree, walked);

  const problems: string[] = [];
  const add = (p: string) => {
    if (!problems.includes(p)) problems.push(p);
  };
  for (const ch of listener.lexer) add(`Unexpected character '${ch}'`);
  if (listener.parser.length) {
    for (const m of text.matchAll(/\{\s*ORDERBY\b[^:{}]*:\s*([^{}]*)\}/gi)) {
      const body = m[1].trim();
      const call = /^[A-Za-z_]\w*\s*\(/.exec(body);
      let single = false;
      let depth = 0;
      if (call) {
        for (let i = call[0].length - 1; i < body.length; i++) {
          if (body[i] === "(") depth++;
          else if (body[i] === ")" && --depth === 0) {
            single = !body.slice(i + 1).trim();
            break;
          }
        }
      }
      if (!single) { add("Tableau Prep allows only one analytic function (RANK, ROW_NUMBER, LOOKUP, ...) inside ORDERBY; arithmetic with its result goes outside the braces"); break; }
    }
    if (/(?:[A-Za-z_]\w*\s*\(|,|\b(?:THEN|ELSE|ELSEIF|WHEN|IF|AND|OR|NOT)\b)\s*\{\s*(?:ORDERBY|PARTITION)\b/i.test(text)) add("A rank, row number or lookup calculation cannot be nested inside another function or an IF in Tableau Prep; it has to be the whole formula, or compared to a number");
    if ([...text.matchAll(/\{\s*(?:FIXED|INCLUDE|EXCLUDE)\b([^:{}]*):/gi)].some(m => m[1].includes("("))) add("A Tableau Prep level-of-detail calculation groups by fields; write a field name like [Order Date], not an expression like YEAR([Order Date])");
  }
  for (const [line, column, symbol, msg] of listener.parser) add(plainParserError(line, column, symbol, msg));
  const specific = walked.incomplete.filter((r) => !GENERIC_INCOMPLETE.has(r));
  for (const rule of specific.length ? specific : walked.incomplete) add(wordsFor(rule));
  for (const name of walked.functions) {
    if (!PREP_FUNCTIONS.has(name.toUpperCase())) add(`Function not in the Tableau Prep reference: ${name}`);
  }
  if (fields && fields.size) {
    const lowered = new Map([...fields].map((f) => [f.toLowerCase(), f]));
    for (const ref of walked.fields) {
      const name = ref.startsWith("[") && ref.endsWith("]") ? ref.slice(1, -1) : ref;
      if (fields.has(name)) continue;
      const written = lowered.get(name.toLowerCase());
      if (written !== undefined) add(`Field [${name}] is written [${written}] in the data`);
      else add(`Field not in the data: [${name}]`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

const TOKEN_RE = /\[[^\]]*\]|'[^']*'|"[^"]*"|#[^#]*#|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|<=|>=|<>|!=|==|\S/g;

/**
 * A formula as the tokens that carry meaning: field names and text as
 * written, numbers, functions and keywords in upper case, operators and
 * brackets. Spacing, comments and the quote style of text are dropped.
 */
export function formulaTokens(formula: unknown): string[] {
  if (typeof formula !== "string") return [];
  const text = formula.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  const out: string[] = [];
  for (const [t] of text.matchAll(TOKEN_RE)) {
    const c = t[0]!;
    if ((c === "'" || c === '"') && t.length >= 2 && t.at(-1) === c) out.push(`'${t.slice(1, -1)}'`);
    else if (c === "[" || c === "#" || /\d/.test(c)) out.push(t);
    else if (/[A-Za-z_]/.test(c)) out.push(t.toUpperCase());
    else out.push(t);
  }
  return out;
}

function clip(tokens: string[], limit = 48): string {
  const text = tokens.join(" ");
  return [...text].length <= limit ? text : `${[...text].slice(0, limit - 1).join("")}…`;
}

/**
 * How much of the written formula matches the expected one, token by token
 * and in order: 2 x matching tokens / (expected + written), 1 for the same
 * formula. With an explanation that names the first difference.
 */
export function formulaSimilarity(expected: unknown, actual: unknown): [number, string] {
  const e = formulaTokens(expected);
  const a = formulaTokens(actual);
  if (!e.length && !a.length) return [1.0, "Both formulas are empty."];
  if (!e.length) return [0.0, "No formula was expected."];
  if (!a.length) return [0.0, "The model wrote no formula."];
  const matcher = new SequenceMatcher(e, a);
  const matched = matcher.getMatchingBlocks().reduce((s, [, , size]) => s + size, 0);
  const ratio = (2 * matched) / (e.length + a.length);
  if (ratio >= 1.0) return [1.0, "The same formula as expected, apart from spacing, letter case or quote style."];
  let first: string | null = null;
  for (const [tag, i1, i2, j1, j2] of matcher.getOpcodes()) {
    if (tag === "equal") continue;
    if (tag === "replace") first = `expected '${clip(e.slice(i1, i2))}', written '${clip(a.slice(j1, j2))}'`;
    else if (tag === "delete") first = `'${clip(e.slice(i1, i2))}' is missing`;
    else first = `'${clip(a.slice(j1, j2))}' is extra`;
    break;
  }
  return [
    ratio,
    `${matched} of the ${e.length} expected tokens appear in order in the written ` +
      `formula (${a.length} tokens). First difference: ${first}.`,
  ];
}

/**
 * formulaSimilarity against the expected formula and against each accepted
 * alternative (a case's `acceptable-calcs`: another reading of the request,
 * or an equivalent formula); the closest one counts. The explanation names
 * the alternative when one scored higher.
 */
export function bestFormulaSimilarity(expected: unknown, accepted: unknown, actual: unknown): [number, string] {
  let [best, explanation] = formulaSimilarity(expected, actual);
  for (const alternative of Array.isArray(accepted) ? accepted : []) {
    if (typeof alternative !== "string" || !alternative.trim()) continue;
    let [ratio, text] = formulaSimilarity(alternative, actual);
    if (ratio > best) {
      if (ratio >= 1) text = "The same formula as an accepted alternative, apart from spacing, letter case or quote style.";
      best = ratio;
      explanation = `Compared with the accepted alternative ${alternative.trim()}: ${text}`;
    }
  }
  return [best, explanation];
}
