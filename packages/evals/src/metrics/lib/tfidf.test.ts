import { test, expect, describe } from "bun:test";
import { cosineSimilarityMatrix } from "./tfidf.ts";
import inputs from "../../../../../goldens/lib/tfidf_cosine/inputs.json" with { type: "json" };
import expected from "../../../../../goldens/lib/tfidf_cosine/expected.json" with { type: "json" };

const TOL = 1e-9; // float-epsilon per goldens/lib/README.md

describe("tfidf_cosine faithfulness vs sklearn golden", () => {
  for (const expCase of expected.cases) {
    const input = inputs.cases.find((c) => c.name === expCase.name)!;
    test(expCase.name, () => {
      const got = cosineSimilarityMatrix(input.sentences);
      const want = expCase.cosine_similarity_matrix;
      expect(got.length).toBe(want.length);
      for (let i = 0; i < want.length; i++) {
        expect(got[i].length).toBe(want[i].length);
        for (let j = 0; j < want[i].length; j++) {
          expect(Math.abs(got[i][j] - want[i][j])).toBeLessThanOrEqual(TOL);
        }
      }
    });
  }
});
