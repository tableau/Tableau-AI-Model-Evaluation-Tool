/**
 * Calculation validator regressions: the
 * calculation validator on formulas a model writes — several lines, NULL
 * branches, geographic fields, ranking functions, polymorphic functions, date
 * arithmetic, comments, blanks.
 */
import { describe, expect, test } from "bun:test";
import { normalizeFormula, TableauValidator } from "./tableau_validator.ts";

const COLUMNS: Record<string, string> = {
  Amount: "number",
  "Task Status": "string",
  State: "geographic",
  "Order Placed Date": "date",
  Code: "number",
  Purpose: "string",
};

const validate = (formula: string) => new TableauValidator(COLUMNS).validate(formula);

describe("valid Tableau formulas pass", () => {
  for (const formula of [
    "CASE [Task Status]\n  WHEN 'Completed' THEN 1\n  ELSE 0\nEND",
    "CASE [Code]\n  WHEN 0 THEN 'a'\n  ELSE NULL\nEND",
    "IF [Amount] > 0\nTHEN 1 ELSE 0 END",
    "IF [Amount] > 0 THEN NULL ELSE [Amount] END",
    "ISOYEAR([Order Placed Date]) = YEAR(TODAY()) - 1\nAND [Amount] > 0",
    "[State] IN ('New York', 'New Jersey')",
    "[State] = 'New York'",
    "LEFT([State], 3) + '_' + [Task Status]",
    "RANK_DENSE(SUM([Amount]), 'desc') <= 5",
    "RANK_PERCENTILE(SUM([Amount]))",
    "ATTR([Purpose]) = 'facility'",
    "MAX([Task Status]) = 'x'",
    "LOOKUP(ATTR([Purpose]), -1) = 'x'",
    "IIF([Amount] > 0, 'yes', 'no') = 'yes'",
    "DATEADD('month', 1, DATETRUNC('month', TODAY())) - 1",
    "DATEDIFF('day', [Order Placed Date], TODAY() - 7)",
    "// the total\nSUM([Amount]) /* all rows */",
    "{ FIXED [Task Status] : SUM([Amount]) }",
    "SUM([Amount]) - LOOKUP(SUM([Amount]), -1)",
  ]) {
    test(JSON.stringify(formula), () => {
      const { isValid, errors } = validate(formula);
      expect(errors).toEqual([]);
      expect(isValid).toBe(true);
    });
  }
});

describe("invalid formulas fail with one plain message", () => {
  for (const [formula, message] of [
    ["", "Empty formula"],
    ["   \n", "Empty formula"],
    ["[Nope] + 1", "Field not in the data source: [Nope]"],
    ["FOO([Amount])", "Unknown function: FOO"],
    ["[Task Status] + 1", "Cannot apply + to string and number"],
    ["[Amount] = 'x'", "Cannot compare number with string using ="],
    ["CASE [Code] WHEN 0 THEN 'a' ELSE 1 END", "The CASE branches return string but ELSE returns number"],
    ["IF [Amount] > 0 THEN 'a' ELSE 1 END", "THEN returns string but ELSE returns number"],
    ["[Amount] IN ('a')", "IN compares a number with a string value ('a')"],
    ["SUM([Amount]) extra", "Syntax Error"],
  ] as const) {
    test(JSON.stringify(formula), () => {
      const { isValid, errors } = validate(formula);
      expect(isValid).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(message);
      expect(errors[0]).not.toContain("None");
    });
  }
});

test("an invalid operand is reported once", () => {
  const { isValid, errors } = validate("[Nope] + 1 > 2");
  expect(isValid).toBe(false);
  expect(errors).toEqual(["Field not in the data source: [Nope]"]);
});

test("normalizeFormula removes comments and line breaks", () => {
  expect(normalizeFormula("SUM(\n[Amount]\n) // total\n/ 2")).toBe("SUM( [Amount] )   / 2");
  expect(normalizeFormula(null)).toBe("");
});
