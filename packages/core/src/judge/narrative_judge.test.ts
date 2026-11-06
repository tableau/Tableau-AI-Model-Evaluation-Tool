import { expect, test } from "bun:test";
import goldens from "../../../../goldens/narrative/judge_expected.json";
import {
  computeNarrativeJudgeMetrics,
  narrativeFactualityScores,
  narrativeGroundTruths,
  narrativeText,
  parseNarrativeFactuality,
  parseNarrativeSimilarity,
} from "./narrative_judge.ts";

test("judge parsing and factuality formulas match captured reference results", () => {
  for (const row of goldens.similarity) {
    expect(parseNarrativeSimilarity(row.text)).toEqual(
      row.result as ReturnType<typeof parseNarrativeSimilarity>,
    );
  }
  for (const row of goldens.factuality) {
    expect(parseNarrativeFactuality(row.text)).toEqual(
      row.result as ReturnType<typeof parseNarrativeFactuality>,
    );
  }
  for (const row of goldens.scores) {
    expect(narrativeFactualityScores(row.total, row.accurate, row.misrepresented)).toEqual(
      row.result as ReturnType<typeof narrativeFactualityScores>,
    );
  }
});

test("similarity reads graded, legacy, fenced and prose-wrapped responses", () => {
  expect(
    parseNarrativeSimilarity(
      '```json\n{"llmIsSimilarScore":7,"llmIsSimilarReasoning":" partial "}\n```',
    ),
  ).toEqual([0.7, "partial"]);
  expect(parseNarrativeSimilarity('Answer: {"llmIsSimilar":true}')).toEqual([1, null]);
  expect(parseNarrativeSimilarity('{"llmIsSimilarScore":30}')).toEqual([1, null]);
  expect(parseNarrativeSimilarity('{"llmIsSimilarScore":"bad"}')).toEqual([null, null]);
});
test("factuality preserves reference denominators and empty-truth behavior", () => {
  expect(
    parseNarrativeFactuality(
      '{"total_truths":5,"semantically_accurate_truths":2,"misrepresented_narratives":["wrong"]}',
    ),
  ).toEqual([5, 2, ["wrong"]]);
  expect(narrativeFactualityScores(5, 2, ["wrong"]).slice(0, 2)).toEqual([0.6667, 0.5]);
  expect(narrativeFactualityScores(5, 0, []).slice(0, 2)).toEqual([1, 0]);
  expect(narrativeFactualityScores(0, 0, []).slice(0, 2)).toEqual([1, 1]);
});
test("ground truths filter artifacts and map captured outlier names", () => {
  expect(
    narrativeGroundTruths([
      {
        name: "Sales",
        artifacts: [
          {
            artifactType: "OUTLIERS",
            artifact: JSON.stringify([
              {
                dimensions: "West",
                measureCaption: "Sales",
                formattedValue: "42",
                isHigh: "true",
                tooltip: "ignored",
              },
            ]),
          },
          { artifactType: "PULSE_INSIGHTS", artifact: JSON.stringify([{ insight: "West leads" }]) },
        ],
      },
    ]),
  ).toEqual({
    outliers: [
      {
        view: "Sales",
        items: [{ caption: "West", columnCaption: "Sales", formattedValue: "42", isHigh: true }],
      },
    ],
    insights: [{ view: "Sales", text: "West leads" }],
  });
  expect(narrativeText({ sections: [{ body: "A\nB", children: [{ body: "C" }] }] })).toBe("A B C");
});
test("unconfigured judge omits scores; empty truths need no factuality call", async () => {
  expect(
    await computeNarrativeJudgeMetrics({
      actualNarrative: "Words",
      expectedNarrative: "Reference",
    }),
  ).toEqual([]);
  const scores = await computeNarrativeJudgeMetrics(
    {
      actualNarrative: "Words",
      expectedNarrative: null,
      judgeCfg: { provider: "openai", api_key: "test" },
    },
    {
      fetchFn: (async () => {
        throw new Error("must not call");
      }) as unknown as typeof fetch,
    },
  );
  expect(scores.map((s) => s.score)).toEqual([1, 1]);
});
