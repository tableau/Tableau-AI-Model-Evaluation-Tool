import { test, expect, describe } from "bun:test";
import { partialRatio, ratio, tokenSetRatio } from "./fuzzy.ts";
import inputs from "../../../../../goldens/lib/fuzzy_ratios/inputs.json" with { type: "json" };
import expected from "../../../../../goldens/lib/fuzzy_ratios/expected.json" with { type: "json" };

// float-epsilon per goldens/lib/README.md (fuzzy_ratios tolerance = 1e-6).
const TOL = 1e-6;

// Preprocessing uses the same conventions as the reference fixtures, as
// applied by the golden generator: a -> a.strip().lower(); b -> b.lower().
describe("fuzzy_ratios faithfulness vs rapidfuzz golden", () => {
  for (const expCase of expected.pairs) {
    const input = inputs.pairs.find((p) => p.name === expCase.name)!;
    test(expCase.name, () => {
      const a = input.a.trim().toLowerCase();
      const b = input.b.toLowerCase();
      expect(Math.abs(tokenSetRatio(a, b) - expCase.token_set_ratio)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(partialRatio(a, b) - expCase.partial_ratio)).toBeLessThanOrEqual(TOL);
    });
  }
});

/** The original scalar DP is a deliberately independent oracle for bit carries. */
function scalarRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] =
        a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return 100 * (1 - (a.length + b.length - 2 * previous[b.length]) / (a.length + b.length));
}

function scalarPartial(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  if (a.length > b.length) [a, b] = [b, a];
  const windows = (shorter: string, longer: string) => {
    let best = 0;
    const chars = new Set(shorter);
    const consider = (start: number, end: number) => {
      best = Math.max(best, scalarRatio(shorter, longer.slice(start, end)));
    };
    for (let i = 1; i < shorter.length; i++) {
      if (chars.has(longer[i - 1])) consider(0, i);
    }
    for (let i = 0; i < longer.length - shorter.length; i++) {
      if (chars.has(longer[i + shorter.length - 1])) consider(i, i + shorter.length);
    }
    for (let i = longer.length - shorter.length; i < longer.length; i++) {
      if (chars.has(longer[i])) consider(i, longer.length);
    }
    return best;
  };
  const score = windows(a, b);
  return a.length === b.length ? Math.max(score, windows(b, a)) : score;
}

test("bit-parallel LCS matches scalar DP across word boundaries and Unicode", () => {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ["a", "b", "c", " ", "é", "界", "😀"];
  const text = (length: number) =>
    Array.from({ length }, () => alphabet[random() % alphabet.length]).join("");
  const lengths = [0, 1, 30, 31, 32, 33, 63, 64, 65, 95, 96, 97, 128, 257];
  for (const length of lengths) {
    for (let i = 0; i < 10; i++) {
      const a = text(length);
      const b = text(random() % 260);
      expect(ratio(a, b)).toBe(scalarRatio(a, b));
      expect(ratio(b, a)).toBe(scalarRatio(b, a));
    }
  }
  for (let i = 0; i < 35; i++) {
    const a = text(random() % 70);
    const b = text(random() % 90);
    expect(partialRatio(a, b)).toBe(scalarPartial(a, b));
  }
  // Dense and disjoint masks exercise borrow/shift carries through every word.
  expect(ratio("a".repeat(129), "a".repeat(257))).toBe(
    scalarRatio("a".repeat(129), "a".repeat(257)),
  );
  expect(ratio("a".repeat(129), "b".repeat(257))).toBe(0);
});
