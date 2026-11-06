import { expect, test } from "bun:test";
import type { RowPayload } from "@tableau-ai-eval/core";
import { describeExpected } from "./orchestrator.ts";

const row = (expected: Record<string, unknown>): RowPayload =>
  ({ test_case_id: "c1", runner: "ect-server", datasource: "ds", utterance: "u", turn: 0,
    expected, actual: {}, latency: null, debug_info: {}, info: { intent: "x" }, metrics: {}, errors: [] }) as unknown as RowPayload;

test("a chart with no written reply gets its description in info", () => {
  const r = row({ notionalSpec: { chart: "bar", fields: [
    { caption: "Sales", role: "measure", aggregation: "sum", encoding: "y" },
    { caption: "Region", role: "dimension", encoding: "x" } ] } });
  describeExpected(r);
  const info = r.info as Record<string, unknown>;
  expect(info.intent).toBe("x");
  expect(String(info.expected_description)).toContain("bar chart");
  expect(String(info.expected_description)).toContain("Region");
});

test("a written expected reply, or no chart, leaves info alone", () => {
  const withReply = row({ notionalSpec: { chart: "bar" }, userFriendlyReply: "Here it is." });
  describeExpected(withReply);
  expect((withReply.info as Record<string, unknown>).expected_description).toBeUndefined();
  const noChart = row({ calculatedFieldFormula: { formula: "SUM([Sales])" } });
  describeExpected(noChart);
  expect((noChart.info as Record<string, unknown>).expected_description).toBeUndefined();
});
