/**
 * Golden test for the Tableau calculation validator.
 *
 * Runs the TS TableauValidator over goldens/validator/inputs.json and asserts
 * agreement with goldens/validator/expected.json (generated from the
 * retained calculation-validator reference results).
 *
 * Matching policy (documented mapping):
 *  - is_valid: MUST match exactly for every case.
 *  - errors on SEMANTIC failures (dynamic validator): MUST match verbatim — the
 *    TS DynamicValidator reproduces the reference error strings exactly.
 *  - errors on SYNTAX failures: the reference message is ANTLR's verbose
 *    "mismatched input ... expecting {big token set}" wording, which a hand-rolled
 *    parser does not reproduce byte-for-byte. For these we require only:
 *      (a) both agree the formula is INVALID, and
 *      (b) the TS error is categorized as a syntax error ("Syntax Error:" prefix).
 *    This mirrors the plan's guiding principle: same valid/invalid + same error
 *    category is acceptable when wording legitimately diverges.
 */
import { test, expect, describe } from "bun:test";
import { TableauValidator } from "./tableau_validator.ts";
import inputs from "../../../../goldens/validator/inputs.json";
import expected from "../../../../goldens/validator/expected.json";

const validColumns = expected._valid_columns as Record<string, string>;

interface ExpectedCase {
  name: string;
  formula: string;
  is_valid: boolean;
  errors: string[];
}

const expectedByName = new Map<string, ExpectedCase>(
  (expected.cases as ExpectedCase[]).map((c) => [c.name, c]),
);

/** A golden case is a "syntax error" case iff its (single) expected error, or
 *  our produced error, is prefixed "Syntax Error:". */
function isSyntaxErrorMessage(msg: string | undefined): boolean {
  return typeof msg === "string" && msg.startsWith("Syntax Error:");
}

describe("TableauValidator golden corpus", () => {
  const validator = new TableauValidator(validColumns);

  for (const input of inputs.cases as { name: string; formula: string }[]) {
    const exp = expectedByName.get(input.name);

    test(input.name, () => {
      expect(exp).toBeDefined();
      const result = validator.validate(input.formula);

      // (a) is_valid must always agree.
      expect(result.isValid).toBe(exp!.is_valid);

      if (exp!.is_valid) {
        expect(result.errors).toEqual([]);
        return;
      }

      // Invalid case: decide syntax vs semantic by the expected message.
      const expIsSyntax = isSyntaxErrorMessage(exp!.errors[0]);
      if (expIsSyntax) {
        // Only require: we also flag a syntax error.
        expect(isSyntaxErrorMessage(result.errors[0])).toBe(true);
      } else {
        // Semantic failure: exact error-message match.
        expect(result.errors).toEqual(exp!.errors);
      }
    });
  }

  test("valid/invalid agreement rate is 100%", () => {
    let agree = 0;
    const total = (inputs.cases as { name: string; formula: string }[]).length;
    for (const input of inputs.cases as { name: string; formula: string }[]) {
      const exp = expectedByName.get(input.name)!;
      const result = validator.validate(input.formula);
      if (result.isValid === exp.is_valid) agree++;
    }
    expect(agree).toBe(total);
  });
});
