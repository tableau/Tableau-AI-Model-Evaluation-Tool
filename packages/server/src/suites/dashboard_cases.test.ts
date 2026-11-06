/**
 * The dashboard behind a Dashboard summaries case, served to the results
 * page.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardName, describe as describeCase, image } from "./dashboard_cases.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)]);

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A folder with one narrative case file (and one broken file beside it). */
function caseDir(withImage = true): string {
  const root = mkdtempSync(join(tmpdir(), "dash-cases-"));
  roots.push(root);
  const folder = join(root, "cases");
  mkdirSync(folder);
  const doc = {
    id: "abc123",
    runner: "dashboard-viz-narrative-config",
    info: { source_url: "https://public.tableau.com/example", source: "Tableau Public" },
    inputs: [
      {
        arguments: {
          dashboardName: "Splits Overview",
          dashboardId: "SplitsOverview",
          views: [
            {
              name: "Fastest Splits",
              datasourceLuid: "x",
              artifacts: [
                { artifactType: "OUTLIERS", artifact: "{}" },
                { artifactType: "OUTLIERS", artifact: "{}" },
                { artifactType: "PULSE_INSIGHTS", artifact: "{}" },
              ],
            },
            { name: "Bike Splits", datasourceLuid: "x", artifacts: [] },
          ],
          dashboardArtifacts: withImage
            ? [{ artifactType: "IMAGE", artifact: Buffer.from(PNG).toString("base64") }]
            : [],
        },
        expected: { insightNarrative: "…" },
      },
    ],
  };
  writeFileSync(join(folder, "Splits_Overview.json"), JSON.stringify(doc));
  writeFileSync(join(folder, "broken.json"), "{not json");
  return folder;
}

describe("dashboard_cases", () => {
  it("dashboardName drops the runner prefix", () => {
    expect(dashboardName("Dashboard Name: HR Attrition Dashboard")).toBe("HR Attrition Dashboard");
    expect(dashboardName("What is sales?")).toBe("What is sales?");
    expect(dashboardName(null)).toBe("");
  });

  it("describes the views, the picture and the link", () => {
    const run = { config: { test_path: caseDir(), suite_id: "dashboard-narratives" } };
    const info = describeCase(run, "abc123")!;
    expect(info.name).toBe("Splits Overview");
    expect(info.has_image).toBe(true);
    expect(info.views).toEqual([
      { name: "Fastest Splits", outliers: 2, insights: 1 },
      { name: "Bike Splits", outliers: 0, insights: 0 },
    ]);
    expect(info.url).toBe("https://public.tableau.com/example");
    expect(info.source).toBe("Tableau Public");
    // A row of a multi-input file is "<id>:<n>".
    expect(describeCase(run, "abc123:0")?.name).toBe("Splits Overview");

    const picture = image(run, "abc123")!;
    expect(picture.mediaType).toBe("image/png");
    expect(Array.from(picture.data)).toEqual(Array.from(PNG));
  });

  it("a config stored as a JSON string is read too", () => {
    expect(describeCase({ config: JSON.stringify({ test_path: caseDir() }) }, "abc123")?.name).toBe(
      "Splits Overview",
    );
  });

  it("a case without a picture says so", () => {
    const run = { config: { test_path: caseDir(false) } };
    expect(describeCase(run, "abc123")?.has_image).toBe(false);
    expect(image(run, "abc123")).toBeNull();
  });

  it("an unknown case, a run without a folder, or a path is nothing", () => {
    const run = { config: { test_path: caseDir() } };
    expect(describeCase(run, "nope")).toBeNull();
    expect(describeCase(run, "../../etc/passwd")).toBeNull();
    expect(describeCase(null, "abc123")).toBeNull();
    expect(describeCase({ config: {} }, "abc123")).toBeNull();
    expect(describeCase({ config: { test_path: "/no/such/dir" } }, "abc123")).toBeNull();
  });
});
