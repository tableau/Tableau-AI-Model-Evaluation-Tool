import { test, expect, describe } from "bun:test";
import {
  fleschScore,
  fleschScoreDiv100,
  wordStats,
  countSentences,
  readingEase,
} from "./flesch.ts";
import inputs from "../../../../../goldens/lib/flesch/inputs.json" with { type: "json" };
import expected from "../../../../../goldens/lib/flesch/expected.json" with { type: "json" };

// Counts: exact if same tokenizer/syllable heuristic. Sentence count: the JS
// tokenizer must reproduce num_sentences_manual (punkt substitute).
// Formula: exact arithmetic. See flesch.ts DIVERGENCE NOTE.
const FORMULA_TOL = 1e-4; // golden rounds raw score to 4 decimals

describe("flesch faithfulness vs py-readability-metrics golden", () => {
  for (const exp of expected.paragraphs) {
    const inp = inputs.paragraphs.find((c) => c.name === exp.name)!;

    test(`${exp.name}: word & syllable counts (exact vs library)`, () => {
      const { numWords, numSyllables, numLetters } = wordStats(inp.text);
      expect(numWords).toBe(exp.num_words);
      expect(numSyllables).toBe(exp.num_syllables);
      expect(numLetters).toBe(exp.num_letters);
    });

    test(`${exp.name}: JS sentence tokenizer reproduces manual count`, () => {
      // punkt substitute — must match the golden's manual sentence count.
      expect(countSentences(inp.text)).toBe(exp.num_sentences_manual);
    });

    test(`${exp.name}: Flesch formula from recorded counts (exact)`, () => {
      const raw = fleschScore({
        numWords: exp.num_words,
        numSentences: exp.num_sentences_manual,
        numSyllables: exp.num_syllables,
      });
      expect(Math.abs(raw - exp.flesch_score_raw)).toBeLessThanOrEqual(FORMULA_TOL);

      const div100 = fleschScoreDiv100({
        numWords: exp.num_words,
        numSentences: exp.num_sentences_manual,
        numSyllables: exp.num_syllables,
      });
      expect(Math.abs(div100 - exp.flesch_score_div100)).toBeLessThanOrEqual(FORMULA_TOL);
    });

    test(`${exp.name}: full readingEase pipeline matches stored score`, () => {
      // Uses the JS sentence tokenizer end-to-end; since it reproduces the
      // manual count on these inputs, the stored score should match.
      const got = readingEase(inp.text);
      expect(Math.abs(got - exp.flesch_score_div100)).toBeLessThanOrEqual(FORMULA_TOL);
    });
  }

  test("<100 words -> 1.0000 fallback (reference behavior)", () => {
    expect(readingEase("The cat sat on the mat.")).toBe(1.0);
  });

  test("100+ words with NO sentence terminator -> finite score (no Infinity)", () => {
    // countSentences can return 0 (e.g. text made entirely of terminators, or
    // in the wild via punkt-vs-regex divergence). With numWords >= 100 the
    // <100-words guard is passed, so numWords/0 would be Infinity → -Infinity
    // score. The clamp to >=1 sentence keeps the score finite and in range.
    const rawZeroSentences = fleschScore({
      numWords: 120,
      numSentences: 0,
      numSyllables: 180,
    });
    expect(Number.isFinite(rawZeroSentences)).toBe(true);
    expect(rawZeroSentences).toBeGreaterThan(-100);
    expect(rawZeroSentences).toBeLessThan(206.835 + 1e-6);

    // End-to-end: a 100+ word terminator-less line must yield a finite score
    // (countSentences returns 1 here; the clamp additionally protects 0).
    const text = Array.from({ length: 120 }, () => "word").join(" ");
    const score = readingEase(text);
    expect(Number.isFinite(score)).toBe(true);
    // readingEase returns round(score/100, 4); the raw Flesch range
    // (~ -100..206.835) maps to roughly -1..2.07 here.
    expect(score).toBeGreaterThan(-1);
    expect(score).toBeLessThan(2.07);
  });
});
