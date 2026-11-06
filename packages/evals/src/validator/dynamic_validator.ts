/**
 * Calculation AST type inference and validation.
 *
 * Walks the AST (built by parser.ts, mirroring the ANTLR labeled alternatives)
 * and accumulates semantic errors: invalid fields, unrecognized functions,
 * argument-type checks and return-type propagation. Regression fixtures pin
 * error messages and type-inference behavior.
 *
 * Important behavior pinned by regression fixtures:
 *  - `visit()` returns a "type" (or null). Many mismatches return null WITHOUT
 *    appending an error (e.g. AGGREGATEWITHSAMEARGUMENTS when return type !=
 *    arg type: `SUM([string field])` is reported VALID). We reproduce that.
 *  - AND/OR return the Python truthy fold `left and right` / `left or right`
 *    over type strings; we model the resulting value the same way (a string or
 *    null) since only null-ness/equality matters downstream.
 *  - IN list appends the mismatch error once PER list element (see golden).
 */
import type {
  Node,
  Field,
  Literal,
  IfFunction,
  CaseFunction,
  Lod,
  WindowFunctionExpr,
  OrderByExpr,
  PartitionWithOrder,
} from "./ast.ts";
import { FUNCTION_TYPES } from "./function_types.ts";

export type ValType = string | null;

/** Field data types a formula treats like another type: a geographic field
 *  (State, City, Country) holds text and compares with string literals. */
const TYPE_ALIASES: Record<string, string> = { geographic: "string", datetime: "date" };

/** NULL takes the type of whatever it stands beside ("ELSE NULL"). */
export const NULL_TYPE = "null";

/** Functions whose result has the type of one of their arguments. */
const SAME_AS_FIRST_ARGUMENT = new Set([
  "attr",
  "lookup",
  "previous_value",
  "total",
  "window_max",
  "window_min",
  "running_max",
  "running_min",
  "max",
  "min",
  "ifnull",
]);
const SAME_AS_SECOND_ARGUMENT = new Set(["iif"]);

/** Two types that may stand together: the same type, or NULL beside any. */
function compatible(a: ValType, b: ValType): boolean {
  return a === b || a === NULL_TYPE || b === NULL_TYPE;
}

/** The type two compatible branches share (NULL defers to the other). */
function merge(a: ValType, b: ValType): ValType {
  return a === NULL_TYPE ? b : a;
}

/** Python str.strip('[]') then str.strip(): strip leading/trailing [ ] chars, then whitespace. */
function stripField(text: string): string {
  let s = text;
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === "[" || s[start] === "]")) start++;
  while (end > start && (s[end - 1] === "[" || s[end - 1] === "]")) end--;
  s = s.slice(start, end);
  return s.trim();
}

export class DynamicValidator {
  private validColumns: Record<string, string>;
  private functionType: Record<string, string>; // lower-cased keys
  errors: string[] = [];

  constructor(
    validColumns: Record<string, string>,
    functionType: Record<string, string> = FUNCTION_TYPES,
  ) {
    this.validColumns = {};
    for (const [name, kind] of Object.entries(validColumns)) {
      if (!kind) {
        this.validColumns[name] = kind;
        continue;
      }
      const lower = String(kind).toLowerCase();
      this.validColumns[name] = TYPE_ALIASES[lower] ?? lower;
    }
    // case-insensitive: {k.lower(): v}
    this.functionType = {};
    for (const [k, v] of Object.entries(functionType)) {
      this.functionType[k.toLowerCase()] = v;
    }
  }

  validate(tree: Node): string[] {
    this.errors = [];
    this.visit(tree);
    return this.errors;
  }

  /** Dispatch on node kind, mirroring the ANTLR visitVs* methods. */
  private visit(node: Node): ValType {
    switch (node.kind) {
      case "Literal":
        return this.visitLiteral(node);
      case "Field":
        return this.visitField(node);
      case "Paren":
        return this.visit(node.inner);
      case "UnaryFunction":
        return this.visitUnary(node.operator, node.operand);
      case "PowerFunction":
        return this.visitPower(node.left, node.right);
      case "MultiplicativeFunction":
        return this.handleAdditiveMultiplicative(node.operator, node.left, node.right);
      case "AdditiveFunction":
        return this.handleAdditiveMultiplicative(node.operator, node.left, node.right);
      case "ComparisonFunction":
        return this.visitComparison(node.operator, node.left, node.right);
      case "NegationFunction":
        return this.visitNegation(node.operator, node.operand);
      case "AndFunction":
        return this.visitAnd(node.left, node.right);
      case "OrFunction":
        return this.visitOr(node.left, node.right);
      case "IfFunction":
        return this.visitIf(node);
      case "CaseFunction":
        return this.visitCase(node);
      case "InList":
        return this.visitInList(node.value, node.list);
      case "InSet":
        return this.visitInSet(node.field);
      case "Lod":
        return this.visitLod(node);
      case "AggregateFunction":
        return this.visitAggregate(node.functionName, node.args);
      case "AggregateWithSameArgumentsFunction":
        return this.visitAggregateWithSameArguments(node.functionName, node.arg);
      case "AggregateCountFunction":
        return this.visitAggregateCount(node.functionName, node.arg);
      case "NumberFunction":
        return this.visitNumberFunction(node.functionName, node.arg);
      case "DateFunction":
        return this.visitDateFunction(node.functionName, node.args);
      case "StringFunction":
        return this.visitStringFunction(node.functionName, node.args);
      case "LogicalFunction":
        return this.visitLogicalFunction(node.functionName, node.arg);
      case "IfNullFunction":
        return this.visitIfNull(node.first, node.second);
      case "GeneralFunction":
        return this.visitGeneralFunction(node.functionName, node.args);
      case "WindowFunctionExpr":
        return this.visitWindowFunctionExpr(node);
      case "PartitionWithOrder":
        return this.visitPartitionWithOrder(node);
      case "OrderByExpr":
        return this.visitOrderByExpr(node);
      default: {
        const _exhaustive: never = node;
        return _exhaustive;
      }
    }
  }

  private visitLiteral(node: Literal): ValType {
    return node.literalType ?? NULL_TYPE; // the parser types a NULL literal as null
  }

  private visitField(node: Field): ValType {
    const fieldName = stripField(node.text);
    if (!(fieldName in this.validColumns)) {
      this.errors.push(`Field not in the data source: [${fieldName}]`);
      return null;
    }
    return this.validColumns[fieldName]!;
  }

  private visitGeneralFunction(functionName: string, args: Node[]): ValType {
    return this.visitFunction(functionName.trim().toLowerCase(), args);
  }

  /** Shared with vsGeneralFunction and vsDateFunction. */
  private visitFunction(functionName: string, args: Node[]): ValType {
    if (!(functionName in this.functionType)) {
      this.errors.push(`Unknown function: ${functionName.toUpperCase()}`);
      return null;
    }

    let allArgumentsValid = true;
    const argumentTypes: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const argType = this.visit(args[i]!);
      if (argType === null) {
        // The argument already reported what is wrong with it.
        allArgumentsValid = false;
      } else {
        argumentTypes.push(argType);
      }
    }
    if (!allArgumentsValid) return null;
    if (SAME_AS_FIRST_ARGUMENT.has(functionName) && argumentTypes.length > 0) {
      return argumentTypes[0]!;
    }
    if (SAME_AS_SECOND_ARGUMENT.has(functionName) && argumentTypes.length > 1) {
      return argumentTypes[1]!;
    }
    return this.functionType[functionName] ?? null;
  }

  private handleAdditiveMultiplicative(
    operator: string,
    left: Node,
    right: Node,
  ): ValType {
    const leftType = this.visit(left);
    const rightType = this.visit(right);

    // An operand that failed already reported what is wrong with it.
    if (leftType === null || rightType === null) return null;

    if (compatible(leftType, rightType)) return merge(leftType, rightType);

    // Tableau date arithmetic: a date plus or minus a number of days is a
    // date, and the difference of two dates is a number.
    if (
      (operator === "+" || operator === "-") &&
      ((leftType === "date" && rightType === "number") ||
        (leftType === "number" && rightType === "date"))
    ) {
      if (leftType === "date" || operator === "+") return "date";
    }
    this.errors.push(`Cannot apply ${operator} to ${leftType} and ${rightType}`);
    return null;
  }

  private visitComparison(operator: string, left: Node, right: Node): ValType {
    const leftType = this.visit(left);
    const rightType = this.visit(right);
    // An operand that failed already reported why; a type mismatch is a new
    // finding.
    if (leftType !== null && rightType !== null && !compatible(leftType, rightType)) {
      this.errors.push(`Cannot compare ${leftType} with ${rightType} using ${operator}`);
    }
    return "boolean";
  }

  private visitNegation(_operator: string, operand: Node): ValType {
    const operandType = this.visit(operand);
    if (operandType === null) return null;
    if (operandType !== "boolean") {
      this.errors.push(`NOT needs a true/false value, found ${operandType}`);
    }
    return operandType;
  }

  private visitAnd(left: Node, right: Node): ValType {
    const l = this.visit(left);
    const r = this.visit(right);
    if (l !== null && r !== null) {
      // Python `l and r`: returns l if l is falsy else r. Type strings are all
      // truthy non-empty, so this yields r. Model that.
      return pyAnd(l, r);
    }
    return null;
  }

  private visitOr(left: Node, right: Node): ValType {
    const l = this.visit(left);
    const r = this.visit(right);
    if (l !== null && r !== null) {
      // Python `l or r`: returns l if truthy else r -> l for non-empty strings.
      return pyOr(l, r);
    }
    return null;
  }

  private visitUnary(operator: string, operand: Node): ValType {
    const operandType = this.visit(operand);
    if (operator === "-" && operandType !== "number") {
      this.errors.push(`Type mismatch: ${operator} ${operandType}`);
      return null;
    }
    return operandType;
  }

  private visitNumberFunction(functionName: string, arg: Node): ValType {
    const name = functionName.trim().toLowerCase();
    const argumentType = this.visit(arg);
    if (argumentType === null) {
      this.errors.push(`Invalid argument in number function ${name}`);
      return null;
    }
    if (argumentType !== "number") {
      this.errors.push(
        `Type mismatch: ${name} expects a number, found ${argumentType}`,
      );
      return null;
    }
    return "number";
  }

  private visitIf(node: IfFunction): ValType {
    const stmts = node.stmts;
    const conditionType = this.visit(stmts[0]!);
    const trueBranchType = this.visit(stmts[1]!);

    if (conditionType !== "boolean") {
      this.errors.push(
        `Type mismatch: IF condition must be boolean, found ${conditionType}`,
      );
      return null;
    }

    let currentType: ValType = trueBranchType;
    const elseifCount = node.elseifCount;

    for (let i = 0; i < elseifCount; i++) {
      const elseifConditionType = this.visit(stmts[2 + 2 * i]!);
      const elseifThenType = this.visit(stmts[3 + 2 * i]!);

      if (elseifConditionType !== "boolean") {
        this.errors.push(
          `Type mismatch: ELSEIF condition must be boolean, found ${elseifConditionType}`,
        );
        return null;
      }

      if (
        currentType !== null &&
        elseifThenType !== null &&
        !compatible(currentType, elseifThenType)
      ) {
        this.errors.push(
          `The THEN branches return different types: ${currentType} and ${elseifThenType}`,
        );
        return null;
      }

      currentType = currentType !== null ? merge(currentType, elseifThenType) : elseifThenType;
    }

    if (node.hasElse) {
      const elseType = this.visit(stmts[stmts.length - 1]!);
      if (
        currentType !== null &&
        elseType !== null &&
        !compatible(currentType, elseType)
      ) {
        this.errors.push(`THEN returns ${currentType} but ELSE returns ${elseType}`);
        return null;
      }
      currentType = currentType !== null ? merge(currentType, elseType) : elseType;
    }

    return currentType;
  }

  private visitAggregate(functionName: string, args: Node[]): ValType {
    const name = functionName.trim().toLowerCase();
    const argumentTypes: ValType[] = [];
    for (const arg of args) {
      argumentTypes.push(this.visit(arg));
    }
    if (name in this.functionType) {
      return argumentTypes[0] ?? null;
    }
    return null;
  }

  private visitAggregateCount(functionName: string, arg: Node): ValType {
    const name = functionName.trim().toLowerCase();
    this.visit(arg);
    if (name in this.functionType) {
      return this.functionType[name]!;
    }
    return null;
  }

  private visitAggregateWithSameArguments(
    functionName: string,
    arg: Node,
  ): ValType {
    const name = functionName.trim().toLowerCase();
    const argumentType = this.visit(arg);
    if (name in this.functionType) {
      const returnType = this.functionType[name]!;
      if (returnType !== argumentType) {
        // NOTE: the reference returns None here but appends NO error -> still "valid".
        return null;
      }
      return returnType;
    }
    return null;
  }

  private visitStringFunction(functionName: string, args: Node[]): ValType {
    const name = functionName.trim().toLowerCase();
    const argumentTypes = args.map((a) => this.visit(a));
    if (name in this.functionType) {
      const returnType = this.functionType[name]!;
      if (returnType === "string") {
        for (const argType of argumentTypes) {
          if (argType !== "string" && argType !== "number") {
            this.errors.push(
              `Type mismatch: ${name} expects a string , found ${argType}`,
            );
            return null;
          }
        }
      }
      return returnType;
    }
    return null;
  }

  private visitDateFunction(functionName: string, args: Node[]): ValType {
    const name = functionName.trim().toLowerCase();
    const returnType = this.visitFunction(name, args);
    return returnType ?? "date"; // Python: return return_type or 'date'
  }

  private visitWindowFunctionExpr(node: WindowFunctionExpr): ValType {
    const name = node.functionName.trim().toLowerCase();
    if (!(name in this.functionType)) {
      this.errors.push(`Unrecognized window function: ${name}`);
      return null;
    }
    for (let i = 0; i < node.args.length; i++) {
      const argType = this.visit(node.args[i]!);
      if (argType === null) {
        this.errors.push(`Invalid argument ${i} in window function ${name}`);
        return null;
      }
    }
    return this.functionType[name] ?? null;
  }

  private visitCase(node: CaseFunction): ValType {
    let branchesType: ValType = null;

    const caseExpressionType = this.visit(node.expr);
    if (caseExpressionType === null) {
      this.errors.push("CASE expression must evaluate to a valid type");
      return null;
    }

    for (const whenClause of node.whens) {
      this.visit(whenClause.condition); // condition_type (unused beyond visiting)
      const resultType = this.visit(whenClause.result);
      // The branch already reported what is wrong with it.
      if (resultType === null) return null;
      if (branchesType === null) {
        branchesType = resultType;
      } else if (!compatible(branchesType, resultType)) {
        this.errors.push(
          `The CASE branches return different types: ${branchesType} and ${resultType}`,
        );
        return null;
      } else {
        branchesType = merge(branchesType, resultType);
      }
    }

    if (node.hasElse) {
      const elseType = this.visit(node.elseStmt!);
      if (elseType === null) return null;
      if (!compatible(elseType, branchesType)) {
        this.errors.push(
          `The CASE branches return ${branchesType} but ELSE returns ${elseType}`,
        );
        return null;
      }
      branchesType = branchesType !== null ? merge(branchesType, elseType) : elseType;
    }

    if (branchesType === null) {
      this.errors.push("CASE function must have at least one THEN branch");
      return null;
    }

    return branchesType;
  }

  private visitInList(value: Node, list: Node[]): ValType {
    const fieldType = this.visit(value);
    let validList = true;
    for (const el of list) {
      const valueType = this.visit(el);
      if (fieldType === null || valueType === null) {
        // Already reported by the operand itself.
        validList = false;
        continue;
      }
      if (!compatible(fieldType, valueType)) {
        this.errors.push(
          `IN compares a ${fieldType} with a ${valueType} value (${nodeText(el)})`,
        );
        validList = false;
      }
    }
    if (validList) return "boolean";
    return null;
  }

  private visitInSet(field: Field): ValType {
    this.visit(field);
    return "boolean";
  }

  private visitPartitionWithOrder(node: PartitionWithOrder): ValType {
    const partitionField = stripField(node.field.text);
    const partitionFieldType = this.validColumns[partitionField] ?? null;
    if (partitionFieldType === null) {
      this.errors.push(`Invalid partition field: ${partitionField}`);
      return null;
    }
    const orderResult = this.visit(node.orderBy);
    if (orderResult === null) {
      this.errors.push(
        `Invalid order expression in partition for field: ${partitionField}`,
      );
      return null;
    }
    return "partition_with_order";
  }

  private visitOrderByExpr(node: OrderByExpr): ValType {
    const orderField = stripField(node.field.text);
    const orderFieldType = this.validColumns[orderField] ?? null;
    if (orderFieldType === null) {
      this.errors.push(`Invalid order-by field: ${orderField}`);
      return null;
    }
    const windowResult = this.visit(node.window);
    if (windowResult === null) {
      this.errors.push(
        `Invalid window function in order-by for field: ${orderField}`,
      );
      return null;
    }
    return "order_expr";
  }

  private visitLogicalFunction(functionName: string, arg: Node): ValType {
    const name = functionName.trim().toLowerCase();
    const argumentType = this.visit(arg);
    if (argumentType === null) {
      this.errors.push(`Invalid argument in logical function ${name}`);
      return null;
    }
    return "boolean";
  }

  private visitIfNull(first: Node, second: Node): ValType {
    const firstType = this.visit(first);
    const secondType = this.visit(second);
    if (firstType === secondType) {
      return firstType;
    }
    // Python: first_expr_type or second_expr_type
    return firstType !== null ? firstType : secondType;
  }

  private visitLod(node: Lod): ValType {
    if (node.dimensions !== null) {
      const dimensionsResult = this.visitLodDimensions(node.dimensions);
      if (dimensionsResult === null) {
        this.errors.push("Invalid LOD dimensions");
        return null;
      }
    }
    const bodyResult = this.visit(node.body);
    if (bodyResult === null) {
      this.errors.push("Invalid expression inside LOD");
      return null;
    }
    return bodyResult;
  }

  private visitLodDimensions(dims: Node[]): ValType {
    for (let i = 0; i < dims.length; i++) {
      const dimType = this.visit(dims[i]!);
      if (dimType === null) {
        this.errors.push(`Invalid dimension in LOD at index ${i}`);
        return null;
      }
    }
    return "lod_dimensions";
  }

  private visitPower(left: Node, right: Node): ValType {
    const baseType = this.visit(left);
    const exponentType = this.visit(right);
    if (baseType === null || exponentType === null) {
      this.errors.push("Invalid argument(s) in power function");
      return null;
    }
    if (baseType !== "number" || exponentType !== "number") {
      this.errors.push(
        `Type mismatch: Power function expects numbers, found ${baseType} ^ ${exponentType}`,
      );
      return null;
    }
    return "number";
  }
}

/** Python `a and b` over non-empty type strings (both truthy) -> b. */
function pyAnd(a: string, b: string): string {
  return a === "" ? a : b;
}
/** Python `a or b` over non-empty type strings -> a. */
function pyOr(a: string, b: string): string {
  return a !== "" ? a : b;
}

/** ANTLR `ctx.getText()` for an IN-list element: the tokens joined with no
 *  whitespace. List elements are literals or fields in practice. */
function nodeText(node: Node): string {
  switch (node.kind) {
    case "Literal":
    case "Field":
      return node.text;
    case "Paren":
      return `(${nodeText(node.inner)})`;
    case "UnaryFunction":
      return `${node.operator}${nodeText(node.operand)}`;
    default:
      return node.kind;
  }
}
