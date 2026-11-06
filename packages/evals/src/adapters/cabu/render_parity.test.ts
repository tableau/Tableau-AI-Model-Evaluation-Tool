import { expect, test } from "bun:test";
import goldens from "../../../../../goldens/cabu/render_expected.json";
import { answerForJudging, renderRowsAsMarkdown } from "./adapter.ts";

test("Dashboard Q&A tables and chart-token replacement match reference fixtures", () => {
  for (const row of goldens.cases) {
    expect(renderRowsAsMarkdown(row.rows)).toBe(row.table);
    expect(answerForJudging(row.answer, row.rows)).toBe(row.judging_answer);
  }
});
