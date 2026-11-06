/** Replay independent Agent reference scores through the native runner. */
import { expect, test } from "bun:test";
import goldens from "../../../../goldens/agent/expected.json";
import { NlqHarnessRunner, RateLimiter } from "./nlq_runner.ts";
import type { FetchLike } from "@tableau-ai-eval/core";

for (const row of goldens.rows) {
  test(`Agent reference parity: ${row.kind} ${row.case}`, async () => {
    const runner = new NlqHarnessRunner({
      fetchImpl: (async () => new Response(JSON.stringify(row.actual))) as unknown as FetchLike,
      sessionFactory: () => null,
      rateLimiter: new RateLimiter({ rate: 1000 }),
      loadDatasource: () => ({ fields: row.datasource_fields }),
    });
    const result = await runner.runCase({
      id: row.case, runner: "ect-server", datasource: "fixture", utterance: "Golden",
      expected: row.expected,
    }, { ces_url: "https://offline", metrics_file: row.kind === "calc" ? "byollm_metrics" : "byollm_viz_metrics" }, []);
    for (const [stage, expected] of Object.entries(row.metrics)) {
      for (const metric of expected || []) {
        const actual = result.metrics?.[stage]?.find(entry => entry.metric_name === metric.metric_name);
        expect(actual?.score as number).toBeCloseTo(metric.score, 6);
        if (metric.metric_name.startsWith("value")) expect(actual?.explanation).toBe(metric.explanation);
      }
    }
  });
}

test("Agent registers a generated calculation before the next turn", async () => {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const runner = new NlqHarnessRunner({
    sessionFactory: () => null,
    rateLimiter: new RateLimiter({ rate: 1000 }),
    loadDatasource: () => ({ fields: [{ caption: "Sales", datatype: "real" }] }),
    loadDatasourceMetadata: () => ({ fields: [{ name: "Sales", caption: "Sales", datatype: "real", values: [1] }] }),
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      calls.push({ url: String(url), method: init?.method || "GET", body });
      if (String(url).endsWith("/datasources")) return Response.json({ datasourceECTId: "ect" });
      if (String(url).includes("/datasources/")) return Response.json({});
      const content = (body.utterance as { content: string }).content;
      if (content.includes("data type")) {
        return Response.json({ intentApplicationDetection: { result: { calculatedFieldDescription: "@real@" } } });
      }
      return Response.json({ intentApplicationDetection: {
        intent: "NLQ_TO_NEW_CALCULATED_FIELD",
        result: { calculatedFieldFormula: { caption: "Double Sales", formula: "[Sales] * 2" } },
      } });
    }) as unknown as FetchLike,
  });
  await runner.runCase({
    id: "followup:0", runner: "ect-server", datasource: "fixture", utterance: "Double sales",
    expected: { calculatedFieldFormula: { formula: "[Sales] * 2" } }, isEnd: false,
  }, { adapter: "agent", ces_url: "https://offline", metrics_file: "byollm_metrics" }, []);
  const registered = calls.find(call => call.method === "PUT");
  expect(registered?.url).toBe("https://offline/analytics-assistant/datasources/ect");
  const metadata = registered?.body.datasourceMetadata as { fields: Record<string, unknown>[] };
  expect(metadata.fields[0].values).toBeUndefined();
  expect(metadata.fields[1]).toEqual({ name: "Double Sales", caption: "Double Sales", description: "Double Sales", formula: "[Sales] * 2", datatype: "real" });
});
