/** Parse with the checked-in grammar; adapt its labeled contexts to the semantic validator's AST. */
import { BaseErrorListener, CommonTokenStream } from "antlr4ng";
import * as G from "./generated/TableauCalculationGrammarParser.ts";
import { calculationLexer, LexError } from "./lexer.ts";
import type { Node, OrderByExpr, WindowFunctionExpr } from "./ast.ts";

export class ParseError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(message);
    this.name = "ParseError";
  }
}

function windowNode(ctx: G.WindowFunctionExprContext): WindowFunctionExpr {
  const partition = ctx.partitionByExpr();
  return { kind: "WindowFunctionExpr", functionName: ctx._functionName!.text!,
    args: ctx.valueStmt().map(toAst), partitionBy: partition ? { kind: "Field", text: partition.field().getText() } : null };
}

function orderNode(ctx: G.OrderByExprContext): OrderByExpr {
  return { kind: "OrderByExpr", field: { kind: "Field", text: ctx.field().getText() },
    direction: ctx.DESC() ? "DESC" : "ASC", window: windowNode(ctx.windowFunctionExpr()) };
}

/** Conversion only: syntax, alternative selection and precedence live exclusively in the .g4. */
function toAst(ctx: G.ValueStmtContext): Node {
  if (ctx instanceof G.VsLiteralContext) {
    const literal = ctx.literal();
    const type = literal.start!.type;
    const P = G.TableauCalculationGrammarParser;
    const literalType = type === P.NULL ? null : type === P.STRINGLITERAL ? "string"
      : type === P.DATELITERAL ? "date" : type === P.BOOLEANLITERAL ? "boolean" : "number";
    return { kind: "Literal", literalType, text: literal.getText() };
  }
  if (ctx instanceof G.VsFieldContext) return { kind: "Field", text: ctx.field().getText() };
  if (ctx instanceof G.VsParenContext) return { kind: "Paren", inner: toAst(ctx.valueStmt()) };
  if (ctx instanceof G.VsUnaryFunctionContext || ctx instanceof G.VsNegationFunctionContext) {
    return { kind: ctx instanceof G.VsUnaryFunctionContext ? "UnaryFunction" : "NegationFunction",
      operator: ctx._functionName!.text!, operand: toAst(ctx.valueStmt()) };
  }
  if (ctx instanceof G.VsPowerFunctionContext || ctx instanceof G.VsMultiplicativeFunctionContext
    || ctx instanceof G.VsAdditiveFunctionContext || ctx instanceof G.VsComparisonFunctionContext
    || ctx instanceof G.VsAndFunctionContext || ctx instanceof G.VsOrFunctionContext) {
    const [left, right] = ctx.valueStmt().map(toAst);
    if (ctx instanceof G.VsPowerFunctionContext) return { kind: "PowerFunction", left: left!, right: right! };
    if (ctx instanceof G.VsAndFunctionContext) return { kind: "AndFunction", left: left!, right: right! };
    if (ctx instanceof G.VsOrFunctionContext) return { kind: "OrFunction", left: left!, right: right! };
    return { kind: ctx instanceof G.VsMultiplicativeFunctionContext ? "MultiplicativeFunction"
      : ctx instanceof G.VsAdditiveFunctionContext ? "AdditiveFunction" : "ComparisonFunction",
      operator: ctx._functionName!.text!, left: left!, right: right! };
  }
  if (ctx instanceof G.VsIfFunctionContext) return { kind: "IfFunction", stmts: ctx.valueStmt().map(toAst),
    elseifCount: ctx.ELSEIF().length, hasElse: ctx.ELSE() !== null };
  if (ctx instanceof G.VsCaseFunctionContext) {
    const stmts = ctx.valueStmt().map(toAst);
    return { kind: "CaseFunction", expr: stmts[0]!, hasElse: ctx.ELSE() !== null, elseStmt: stmts[1] ?? null,
      whens: ctx.whenClause().map((clause) => {
        const [condition, result] = clause.valueStmt().map(toAst);
        return { condition: condition!, result: result! };
      }) };
  }
  if (ctx instanceof G.VsInListContext) return { kind: "InList", value: toAst(ctx.valueStmt()), list: ctx.inList().valueStmt().map(toAst) };
  if (ctx instanceof G.VsInSetContext) return { kind: "InSet", value: toAst(ctx.valueStmt()), field: { kind: "Field", text: ctx.field().getText() } };
  if (ctx instanceof G.VsLODContext) return { kind: "Lod", scope: ctx._functionName?.text?.toLowerCase() ?? null,
    dimensions: ctx.lodDimensions()?.valueStmt().map(toAst) ?? null, body: toAst(ctx.valueStmt()) };
  if (ctx instanceof G.VsAggregateFunctionContext || ctx instanceof G.VsDateFunctionContext
    || ctx instanceof G.VsStringFunctionContext || ctx instanceof G.VsGeneralFunctionContext) {
    return { kind: ctx instanceof G.VsAggregateFunctionContext ? "AggregateFunction"
      : ctx instanceof G.VsDateFunctionContext ? "DateFunction"
      : ctx instanceof G.VsStringFunctionContext ? "StringFunction" : "GeneralFunction",
      functionName: ctx._functionName!.text!, args: ctx.valueStmt().map(toAst) };
  }
  if (ctx instanceof G.VsAggregateWithSameArgumentsFunctionContext || ctx instanceof G.VsAggregateCountFunctionContext
    || ctx instanceof G.VsNumberFunctionContext || ctx instanceof G.VsLogicalFunctionContext) {
    return { kind: ctx instanceof G.VsAggregateWithSameArgumentsFunctionContext ? "AggregateWithSameArgumentsFunction"
      : ctx instanceof G.VsAggregateCountFunctionContext ? "AggregateCountFunction"
      : ctx instanceof G.VsNumberFunctionContext ? "NumberFunction" : "LogicalFunction",
      functionName: ctx._functionName!.text!, arg: toAst(ctx.valueStmt()) };
  }
  if (ctx instanceof G.VsIFNullFunctionContext) {
    const [first, second] = ctx.valueStmt().map(toAst);
    return { kind: "IfNullFunction", first: first!, second: second! };
  }
  if (ctx instanceof G.VsWindowFunctionExprContext) return windowNode(ctx.windowFunctionExpr());
  if (ctx instanceof G.VsOrderExprContext) return orderNode(ctx.orderByExpr());
  if (ctx instanceof G.VsPartitionWithOrderContext) {
    const partition = ctx.partitionExprWithOrder();
    return { kind: "PartitionWithOrder", field: { kind: "Field", text: partition.field().getText() }, orderBy: orderNode(partition.orderByExpr()) };
  }
  throw new Error(`Unhandled calculation grammar alternative: ${ctx.constructor.name}`);
}

export interface ParseResult { ok: boolean; tree: Node | null; error: string | null }

export function parse(formula: string): ParseResult {
  try {
    const parser = new G.TableauCalculationGrammarParser(new CommonTokenStream(calculationLexer(formula)));
    parser.removeErrorListeners();
    // Never validate an error-recovered tree. Preserve the existing first-error API.
    const listener = new BaseErrorListener();
    listener.syntaxError = (_recognizer, _symbol, line, column, message) => {
      throw new ParseError(message, line, column);
    };
    parser.addErrorListener(listener);
    return { ok: true, tree: toAst(parser.calculation().valueStmt()), error: null };
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return { ok: false, tree: null, error: `Syntax error at line ${error.line}, column ${error.column}: ${error.message}` };
    }
    throw error;
  }
}
