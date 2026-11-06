/**
 * AST node definitions mirroring the labeled alternatives of the `valueStmt`
 * rule in TableauCalculationGrammar.g4. Node `kind`s correspond 1:1 to the
 * ANTLR context classes that DynamicValidator dispatches on (Vs* + helpers),
 * so the semantic validator can infer types and report errors consistently.
 */

export type Node =
  | Literal
  | Field
  | Paren
  | UnaryFunction
  | PowerFunction
  | MultiplicativeFunction
  | AdditiveFunction
  | ComparisonFunction
  | NegationFunction
  | AndFunction
  | OrFunction
  | IfFunction
  | CaseFunction
  | InList
  | InSet
  | Lod
  | AggregateFunction
  | AggregateWithSameArgumentsFunction
  | AggregateCountFunction
  | NumberFunction
  | DateFunction
  | StringFunction
  | LogicalFunction
  | IfNullFunction
  | GeneralFunction
  | WindowFunctionExpr
  | PartitionWithOrder
  | OrderByExpr;

export type LiteralType = "number" | "string" | "boolean" | "date" | null;

export interface Literal {
  kind: "Literal";
  literalType: LiteralType; // number/string/boolean/date; null for NULL literal
  text: string;
}

export interface Field {
  kind: "Field";
  /** raw token text, e.g. "[Sales]" */
  text: string;
}

export interface Paren {
  kind: "Paren";
  inner: Node;
}

export interface UnaryFunction {
  kind: "UnaryFunction";
  operator: string; // '-'
  operand: Node;
}

export interface PowerFunction {
  kind: "PowerFunction";
  left: Node;
  right: Node;
}

export interface MultiplicativeFunction {
  kind: "MultiplicativeFunction";
  operator: string; // % / *
  left: Node;
  right: Node;
}

export interface AdditiveFunction {
  kind: "AdditiveFunction";
  operator: string; // + -
  left: Node;
  right: Node;
}

export interface ComparisonFunction {
  kind: "ComparisonFunction";
  operator: string;
  left: Node;
  right: Node;
}

export interface NegationFunction {
  kind: "NegationFunction";
  operator: string; // NOT
  operand: Node;
}

export interface AndFunction {
  kind: "AndFunction";
  left: Node;
  right: Node;
}

export interface OrFunction {
  kind: "OrFunction";
  left: Node;
  right: Node;
}

export interface IfFunction {
  kind: "IfFunction";
  /**
   * Flat list of valueStmts in source order, mirroring ctx.valueStmt():
   * [0]=condition, [1]=then, then (elseif-cond, elseif-then)*, optional final else.
   */
  stmts: Node[];
  elseifCount: number;
  hasElse: boolean;
}

export interface WhenClause {
  condition: Node;
  result: Node;
}

export interface CaseFunction {
  kind: "CaseFunction";
  expr: Node;
  whens: WhenClause[];
  hasElse: boolean;
  elseStmt: Node | null;
}

export interface InList {
  kind: "InList";
  value: Node;
  list: Node[];
}

export interface InSet {
  kind: "InSet";
  value: Node;
  field: Field;
}

export interface Lod {
  kind: "Lod";
  scope: string | null; // FIXED/INCLUDE/EXCLUDE lowercased, or null
  dimensions: Node[] | null; // present only if lodDimensions matched
  body: Node;
}

export interface AggregateFunction {
  kind: "AggregateFunction";
  functionName: string; // MIN/MAX text
  args: Node[];
}

export interface AggregateWithSameArgumentsFunction {
  kind: "AggregateWithSameArgumentsFunction";
  functionName: string; // SUM/AVG text
  arg: Node;
}

export interface AggregateCountFunction {
  kind: "AggregateCountFunction";
  functionName: string; // COUNT/COUNTD text
  arg: Node;
}

export interface NumberFunction {
  kind: "NumberFunction";
  functionName: string;
  arg: Node;
}

export interface DateFunction {
  kind: "DateFunction";
  functionName: string;
  args: Node[];
}

export interface StringFunction {
  kind: "StringFunction";
  functionName: string;
  args: Node[];
}

export interface LogicalFunction {
  kind: "LogicalFunction";
  functionName: string;
  arg: Node;
}

export interface IfNullFunction {
  kind: "IfNullFunction";
  first: Node;
  second: Node;
}

export interface GeneralFunction {
  kind: "GeneralFunction";
  functionName: string; // FUNCTIONORFIELD text
  args: Node[];
}

export interface WindowFunctionExpr {
  kind: "WindowFunctionExpr";
  functionName: string;
  args: Node[];
  partitionBy: Field | null;
}

export interface PartitionWithOrder {
  kind: "PartitionWithOrder";
  field: Field;
  orderBy: OrderByExpr;
}

export interface OrderByExpr {
  kind: "OrderByExpr";
  field: Field;
  direction: "ASC" | "DESC";
  window: WindowFunctionExpr;
}
