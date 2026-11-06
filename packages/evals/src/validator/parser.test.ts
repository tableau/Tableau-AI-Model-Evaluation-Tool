/**
 * Parser/lexer edge-case unit tests. These exercise constructs and quirks that
 * are lighter in the main golden corpus but that the generated parser must
 * handle: whitespace/comment skipping, scientific notation, unicode field
 * names, window/partition/orderby, nested LOD, and doubled-quote escapes.
 *
 * Expected results were confirmed against the reference validator.
 */
import { test, expect, describe } from "bun:test";
import { TableauValidator } from "./tableau_validator.ts";
import { tokenize, TokenType } from "./lexer.ts";
import { parse } from "./parser.ts";

const vc: Record<string, string> = {
  Sales: "number",
  Category: "string",
  "Order Date": "date",
  Café: "number", // unicode field
};

const v = new TableauValidator(vc);

describe("window / partition / orderby (confirmed against the reference validator)", () => {
  test("window function with PARTITION BY", () => {
    const r = v.validate("RUNNING_SUM(SUM([Sales])) PARTITION BY [Category]");
    expect(r.isValid).toBe(true);
  });

  test("top-level ORDERBY expr", () => {
    const r = v.validate("{ORDERBY [Category] ASC : RUNNING_SUM(SUM([Sales]))}");
    expect(r.isValid).toBe(true);
  });

  test("PARTITION with nested ORDERBY", () => {
    const r = v.validate(
      "{PARTITION [Category] : {ORDERBY [Sales] DESC : RANK(SUM([Sales]))}}",
    );
    expect(r.isValid).toBe(true);
  });

  test("IN set", () => {
    const r = v.validate("[Sales] IN [Category]");
    expect(r.isValid).toBe(true);
  });
});

describe("whitespace, comments, numbers", () => {
  test("line comment is skipped", () => {
    expect(v.validate("SUM([Sales]) // a comment").isValid).toBe(true);
  });

  test("block comment is skipped", () => {
    expect(v.validate("SUM([Sales]) /* block */ + SUM([Sales])").isValid).toBe(
      true,
    );
  });

  test("scientific notation is a number", () => {
    expect(v.validate("1.5e3 + [Sales]").isValid).toBe(true);
  });

  test("IF with only THEN (no ELSE) is valid", () => {
    expect(v.validate("IF TRUE THEN 1 END").isValid).toBe(true);
  });
});

describe("unicode field names (\\p{L} fragment)", () => {
  test("unicode field resolves", () => {
    expect(v.validate("SUM([Café])").isValid).toBe(true);
  });
});

describe("lexer token classification", () => {
  test("keywords are case-insensitive", () => {
    const toks = tokenize("sum([Sales])");
    expect(toks[0]!.type).toBe(TokenType.AGGREGATEWITHSAMEARGUMENTS);
  });

  test("bracket names and secondary names", () => {
    const toks = tokenize("[a].[b]");
    expect(toks[0]!.type).toBe(TokenType.SECONDARYFIELDNAME);
    expect(toks[0]!.text).toBe("[a].[b]");
  });

  test("doubled-quote escape inside string literal", () => {
    const toks = tokenize('"he said ""hi"""');
    expect(toks[0]!.type).toBe(TokenType.STRINGLITERAL);
    expect(toks[0]!.text).toBe('"he said ""hi"""');
  });

  test("comparison operators", () => {
    const toks = tokenize("a >= b <> c != d == e");
    const types = toks.filter(
      (t) =>
        t.type === TokenType.GEQ ||
        t.type === TokenType.NEQ ||
        t.type === TokenType.EQ,
    );
    expect(types.map((t) => t.type)).toEqual([
      TokenType.GEQ,
      TokenType.NEQ,
      TokenType.NEQ,
      TokenType.EQ,
    ]);
  });
});

describe("parser error surface", () => {
  test("garbage char reported as syntax error", () => {
    const r = parse("@@@");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Syntax error");
  });

  test("unbalanced paren reported", () => {
    const r = parse("SUM([Sales]");
    expect(r.ok).toBe(false);
  });
});

describe("generated grammar AST mapping", () => {
  test("operator precedence and left associativity come from the grammar", () => {
    expect(parse("1 + 2 * 3 ^ 4").tree).toMatchObject({ kind: "AdditiveFunction", right: {
      kind: "MultiplicativeFunction", right: { kind: "PowerFunction" },
    } });
    expect(parse("1 - 2 - 3").tree).toMatchObject({ kind: "AdditiveFunction", left: { kind: "AdditiveFunction" } });
    // Prefix precedence is determined by ANTLR's left-recursion rewrite.
    expect(parse("-2 ^ 2").tree).toMatchObject({ kind: "UnaryFunction", operand: { kind: "PowerFunction" } });
    expect(parse("NOT 1 = 2 AND TRUE OR FALSE").tree).toMatchObject({ kind: "OrFunction", left: {
      kind: "AndFunction", left: { kind: "NegationFunction", operand: { kind: "ComparisonFunction" } },
    } });
  });

  test("CASE, IF, LOD, empty/trailing-comma IN lists", () => {
    expect(parse("CASE [x] WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'c' END").tree)
      .toMatchObject({ kind: "CaseFunction", hasElse: true, whens: [{ result: { text: "'a'" } }, { result: { text: "'b'" } }], elseStmt: { text: "'c'" } });
    expect(parse("IF TRUE THEN 1 ELSEIF FALSE THEN 2 ELSE 3 END").tree)
      .toMatchObject({ kind: "IfFunction", elseifCount: 1, hasElse: true, stmts: [{}, {}, {}, {}, {}] });
    expect(parse("{FIXED [x], [y] : SUM([z])}").tree)
      .toMatchObject({ kind: "Lod", scope: "fixed", dimensions: [{ text: "[x]" }, { text: "[y]" }] });
    expect(parse("1 IN ()").tree).toMatchObject({ kind: "InList", list: [] });
    expect(parse("1 IN (1, 2,)").tree).toMatchObject({ kind: "InList", list: [{ text: "1" }, { text: "2" }] });
  });

  test("syntax errors never expose a recovered tree", () => {
    for (const formula of ["1 +", "IF TRUE THEN 1", "SUM([x]) junk", "1 @ 2", "CASE 1 END"]) {
      expect(parse(formula)).toMatchObject({ ok: false, tree: null });
    }
    expect(parse("1 +\n @").error).toContain("line 2");
  });
});
