import { test, expect, describe } from "bun:test";
import { evaluate, EmptyRunError } from "./ir.ts";
import inputs from "../../../../../goldens/lib/ranx_ir/inputs.json" with { type: "json" };
import expected from "../../../../../goldens/lib/ranx_ir/expected.json" with { type: "json" };

const TOL = 1e-9; // float-epsilon for map/mrr/precision/recall; hit_rate exact (0/1)
const metrics = inputs.metrics;

describe("ranx_ir faithfulness vs ranx golden", () => {
  for (const expCase of expected.cases) {
    const input = inputs.cases.find((c) => c.name === expCase.name)!;
    test(expCase.name, () => {
      const qrels = input.qrels.q1 as unknown as Record<string, number>;
      const run = input.run.q1 as unknown as Record<string, number>;
      const em = expCase.metrics as unknown as Record<string, unknown>;

      // Empty-run short-circuit: golden records _ranx_evaluated:false and our
      // API throws EmptyRunError so callers short-circuit (matches reference).
      if (em._ranx_evaluated === false) {
        expect(() => evaluate(qrels, run, metrics)).toThrow(EmptyRunError);
        return;
      }

      const got = evaluate(qrels, run, metrics);
      for (const m of metrics) {
        const want = em[m] as number;
        expect(Math.abs(got[m] - want)).toBeLessThanOrEqual(TOL);
      }
    });
  }
});
