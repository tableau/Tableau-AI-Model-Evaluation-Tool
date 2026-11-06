/** NarrativeRunner's active (monolith pulse-insights) request path. */
import { createHash } from "node:crypto";

export const NARRATIVE_RUNNER = "dashboard-viz-narrative-config";
export const NARRATIVE_PATH = "/analytics-assistant/dashboards/insights";
export const NARRATIVE_HEADERS = {
  Accept: "application/vnd.analytics-assistant.dashboard-insights.v1.0+json",
  "Content-Type": "application/json",
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dashboard summaries needs captured dashboard arguments and artifacts");
  }
  return value as Record<string, unknown>;
}

/** Deterministic view correlation for a narrative case. */
export function narrativePayload(
  argumentsValue: unknown,
  now = new Date(),
  explicitTrace?: string,
): Record<string, unknown> {
  const args = object(argumentsValue);
  if (
    !Array.isArray(args.dashboardArtifacts) ||
    !Array.isArray(args.views) ||
    !args.dashboardName
  ) {
    throw new Error(
      "Dashboard summaries needs dashboardId, dashboardName, views and dashboardArtifacts",
    );
  }
  const artifacts = args.dashboardArtifacts.map((artifact) => ({ ...object(artifact), vizId: "" }));
  const views = args.views.map((value, index) => {
    const view = object(value);
    const clientId = `view-${index}-${createHash("md5").update(String(view.name)).digest("hex").slice(0, 8)}`;
    for (const value of Array.isArray(view.artifacts) ? view.artifacts : []) {
      const artifact = object(value);
      if (artifact.artifactType === "OUTLIERS" || artifact.artifactType === "PULSE_INSIGHTS") {
        artifacts.push({ ...artifact, vizId: clientId });
      }
    }
    return { name: view.name, clientId, datasourceLuid: view.datasourceLuid || "" };
  });
  const pad = (n: number) => String(n).padStart(2, "0");
  const trace =
    explicitTrace ??
    `Test Bench Run ${pad(now.getMonth() + 1)}${pad(now.getDate())}${now.getFullYear()}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return {
    artifacts,
    dashboardMetadata: { clientId: args.dashboardId || String(args.dashboardName).replace(/ /g, ""), name: args.dashboardName, views },
    insightFormatOptions: {},
    localization: { locale: "en_US", language: "en_US" },
    traceInfo: { sessionId: trace, traceId: trace },
  };
}
