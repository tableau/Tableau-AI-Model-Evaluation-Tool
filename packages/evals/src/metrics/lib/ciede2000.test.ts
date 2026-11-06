import { test, expect, describe } from "bun:test";
import { deltaECIE2000, hexToLab, distinguishabilityScore } from "./ciede2000.ts";
import inputs from "../../../../../goldens/lib/ciede2000/inputs.json" with { type: "json" };
import expected from "../../../../../goldens/lib/ciede2000/expected.json" with { type: "json" };

const TOL = 1e-6; // float-epsilon per README (trig/gamma last-digit drift)
const threshold = inputs.min_distance_threshold;

describe("ciede2000 faithfulness vs colour-science golden", () => {
  describe("lab_pairs (raw LAB -> delta-E)", () => {
    for (const exp of expected.lab_pairs) {
      const inp = inputs.lab_pairs.find((c) => c.name === exp.name)!;
      test(exp.name, () => {
        const got = deltaECIE2000(
          inp.lab1 as [number, number, number],
          inp.lab2 as [number, number, number],
        );
        expect(Math.abs(got - exp.delta_e)).toBeLessThanOrEqual(TOL);
      });
    }
  });

  describe("hex_pairs (hex -> LAB -> delta-E)", () => {
    for (const exp of expected.hex_pairs) {
      const inp = inputs.hex_pairs.find((c) => c.name === exp.name)!;
      test(exp.name, () => {
        const lab1 = hexToLab(inp.hex1);
        const lab2 = hexToLab(inp.hex2);
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(lab1[i] - exp.lab1[i])).toBeLessThanOrEqual(TOL);
          expect(Math.abs(lab2[i] - exp.lab2[i])).toBeLessThanOrEqual(TOL);
        }
        const got = deltaECIE2000(lab1, lab2);
        expect(Math.abs(got - exp.delta_e)).toBeLessThanOrEqual(TOL);
      });
    }
  });

  describe("palettes (distinguishability aggregation)", () => {
    for (const exp of expected.palettes) {
      const inp = inputs.palettes.find((c) => c.name === exp.name)!;
      test(exp.name, () => {
        const got = distinguishabilityScore(inp.colors, threshold);
        // score should be exact given matching delta-E inputs
        expect(Math.abs(got.score - exp.score)).toBeLessThanOrEqual(TOL);
        expect(Math.abs((got.min_distance ?? NaN) - exp.min_distance)).toBeLessThanOrEqual(TOL);
        expect(got.distances.length).toBe(exp.distances.length);
        for (let k = 0; k < exp.distances.length; k++) {
          expect(got.distances[k][0]).toBe(exp.distances[k][0]);
          expect(got.distances[k][1]).toBe(exp.distances[k][1]);
          expect(Math.abs(got.distances[k][2] - exp.distances[k][2])).toBeLessThanOrEqual(TOL);
        }
      });
    }
  });
});
