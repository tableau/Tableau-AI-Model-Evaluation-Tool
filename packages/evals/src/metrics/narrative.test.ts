import { expect, test } from "bun:test";
import goldens from "../../../../goldens/narrative/expected.json";
import { computeNarrativeMetricsAsync } from "./narrative_pool.ts";

for (const row of goldens.rows)
  test(`narrative reference parity: ${row.case} ${row.source}`, async () => {
    const actual = await computeNarrativeMetricsAsync(row.views, row.expected, row.actual);
    expect(actual.length).toBe(row.metrics.length);
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i].metric_id).toBe(row.metrics[i].metric_id);
      expect(actual[i].metric_name).toBe(row.metrics[i].metric_name);
      expect(actual[i].score as number).toBeCloseTo(row.metrics[i].score, 6);
      // Python sets do not promise an order for missing truths. Compare lines,
      // leaving their ordinal prefixes out, but retain the exact wording.
      const lines = (s: unknown) =>
        typeof s === "string"
          ? s
              .split("\n")
              .map((l) => l.replace(/^\d+\. /, ""))
              .sort()
          : s;
      expect(lines(actual[i].explanation)).toEqual(lines(row.metrics[i].explanation));
    }
  }, 30000);
