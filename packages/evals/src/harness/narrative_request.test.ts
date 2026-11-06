import { expect, test } from "bun:test";
import golden from "../../../../goldens/narrative/request_expected.json";
import { readFileSync } from "node:fs";
import { NlqHarnessRunner, RateLimiter, conversationFromFile } from "./nlq_runner.ts";
import { narrativePayload, NARRATIVE_HEADERS } from "./narrative_request.ts";
import type { FetchLike } from "@tableau-ai-eval/core";

test("standalone narrative request matches reference including duplicate view names", () => {
  expect(narrativePayload(golden.arguments, undefined, golden.trace)).toEqual(golden.request);
});

test("narrative payload carries dashboard artifacts and correlates view insights without mutating input", () => {
  const args = {
    dashboardId: "d", dashboardName: "Dashboard",
    dashboardArtifacts: [{ artifactType: "IMAGE", artifact: "base64" }],
    views: [{ name: "Sales", datasourceLuid: "ds", artifacts: [
      { artifactType: "OUTLIERS", artifact: "outliers" },
      { artifactType: "PULSE_INSIGHTS", artifact: "insights" },
      { artifactType: "IMAGE", artifact: "view-image" },
    ] }],
  };
  const before = JSON.stringify(args);
  const payload = narrativePayload(args, new Date(2026, 9, 13, 12, 34, 56));
  const views = (payload.dashboardMetadata as { views: { clientId: string }[] }).views;
  expect(payload.artifacts).toEqual([
    { artifactType: "IMAGE", artifact: "base64", vizId: "" },
    { artifactType: "OUTLIERS", artifact: "outliers", vizId: views[0]!.clientId },
    { artifactType: "PULSE_INSIGHTS", artifact: "insights", vizId: views[0]!.clientId },
  ]);
  expect(payload.localization).toEqual({ locale: "en_US", language: "en_US" });
  expect(payload.traceInfo).toEqual({ sessionId: "Test Bench Run 10132026123456", traceId: "Test Bench Run 10132026123456" });
  expect(JSON.stringify(args)).toBe(before);
});

test("a shipped dashboard case posts to dashboard insights, never authoring conversations", async () => {
  const doc = JSON.parse(readFileSync(new URL("../../../../public-suites/dashboard-narratives/cases/Alliance_Page.json", import.meta.url), "utf8"));
  const c = conversationFromFile(doc)[0]!;
  expect(c.utterance).toBe("Dashboard Name: Alliance Page");
  expect(c.arguments).toEqual(doc.inputs[0].arguments);
  let calls = 0;
  const runner = new NlqHarnessRunner({
    sessionFactory: () => null,
    rateLimiter: new RateLimiter({ rate: 1_000_000, sleep: async () => {} }),
    fetchImpl: (async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://offline.example/content-exploration/analytics-assistant/dashboards/insights");
      expect(init?.headers).toEqual(NARRATIVE_HEADERS);
      const body = JSON.parse(String(init?.body));
      expect(body.utterance).toBeUndefined();
      expect(body.dashboardMetadata.name).toBe("Alliance Page");
      expect(body.artifacts.length).toBeGreaterThan(0);
      expect(body.artifacts[0].artifact).toBe(doc.inputs[0].arguments.dashboardArtifacts[0].artifact);
      return Response.json({ insightNarrative: "Flights increased." });
    }) as FetchLike,
  });
  const result = await runner.runCase(c, { ces_url: "https://offline.example/content-exploration" }, []);
  expect(calls).toBe(1);
  expect(result.actual?.insightNarrative).toBe("Flights increased.");
  expect(result.errors).toEqual([]);
});

test("missing dashboard arguments fail locally instead of sending an authoring request", async () => {
  let calls = 0;
  const runner = new NlqHarnessRunner({ sessionFactory: () => null, fetchImpl: (async () => { calls++; return Response.json({}); }) as unknown as FetchLike });
  const result = await runner.runCase({ id: "d", runner: "dashboard-viz-narrative-config", utterance: "", expected: { insightNarrative: "Summary" } }, { ces_url: "https://offline.example" }, []);
  expect(calls).toBe(0);
  expect(result.errors?.[0]?.description).toContain("captured dashboard arguments");
});
