/** The 17 shipped narrative cases have complete captures and public source attribution. */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSuites } from "./catalog.ts";
// The repository's own folders, not the env-resolved ones: other test files
// point TABLEAU_AI_EVAL_* overrides elsewhere while this one loads.
const REPO = join(import.meta.dir, "..", "..", "..", "..");
const PUBLIC_ROOT = join(REPO, "public-suites");
const PUBLIC_DASHBOARDS = [
  "Alliance_Page.json", "main_page.json", "Employee_Churn.json", "Airlines_Page.json",
  "HR_Headcount_Executive_Summary.json", "Correlation_Dashboard.json", "Commission_Model.json",
  "Profitability_KPI.json", "Revenue_by_State.json", "Boston_Marathon_Dashboard_1.json",
  "Telecommunications_Dashboard.json",
];
const KEPT = new Set([
  "COVID-19_Global_View.json",
  "Expenses_Audit.json",
  "NHS_Hospital_Admitted_Patient_Care.json",
  "HLS_Patient_record.json",
  "Supply_Chain.json",
  "Website_Traffic_Overview.json",
]);
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// biome-ignore lint/suspicious/noExplicitAny: case documents are free-form JSON
type Doc = Record<string, any>;

function readCases(folder: string): Record<string, Doc> {
  const out: Record<string, Doc> = {};
  for (const name of readdirSync(folder).filter((n) => n.endsWith(".json")).sort()) {
    out[name] = JSON.parse(readFileSync(join(folder, name), "utf-8"));
  }
  return out;
}

function publicCases(): Record<string, Doc> {
  return readCases(join(PUBLIC_ROOT, "dashboard-narratives", "cases"));
}


const sorted = (xs: Iterable<string>) => [...xs].sort();

/** What the runner and scorer read from a case, with the payloads blanked. */
function shape(doc: Doc): Doc {
  const turn = doc.inputs[0];
  const args = turn.arguments;
  return {
    runner: doc.runner,
    top_keys: sorted(Object.keys(doc).filter((k) => k !== "info")),
    turn_keys: sorted(Object.keys(turn)),
    argument_keys: sorted(Object.keys(args)),
    view_keys: args.views.length
      ? sorted(new Set(args.views.flatMap((v: Doc) => Object.keys(v))))
      : ["artifacts", "datasourceLuid", "name"],
    artifact_types: sorted(new Set(args.dashboardArtifacts.map((a: Doc) => a.artifactType as string))),
    expected_keys: sorted(Object.keys(turn.expected)),
  };
}

test("every public case has the shape the runner reads", () => {
  const cases = publicCases();
  expect(Object.keys(cases).length).toBe(17);
  const reference = shape(cases["Expenses_Audit.json"]!);
  for (const [name, doc] of Object.entries(cases)) {
    expect([name, shape(doc)]).toEqual([name, reference]);
    const args = doc.inputs[0].arguments;
    expect(args.dashboardName).toBeTruthy();
    expect([name, args.dashboardId]).toEqual([name, args.dashboardName.replaceAll(" ", "")]);
    expect([name, doc.id]).toEqual([name, createHash("md5").update(args.dashboardName, "utf8").digest("hex")]);
    const image = args.dashboardArtifacts.filter((a: Doc) => a.artifactType === "IMAGE");
    expect(image.length).toBeGreaterThan(0);
    const head = [...Buffer.from(image[0].artifact, "base64").subarray(0, 8)];
    expect([name, head]).toEqual([name, PNG_MAGIC]);
  }
  const ids = Object.values(cases).map((d) => d.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("the replacements are public and complete", () => {
  const cases = publicCases();
  expect(sorted(Object.keys(cases))).toEqual(sorted([...KEPT, ...PUBLIC_DASHBOARDS]));
  for (const replacement of PUBLIC_DASHBOARDS) {
    const doc = cases[replacement]!;
    const args = doc.inputs[0].arguments;
    const info = doc.info;
    expect(info.source).toBe("Tableau Public");
    expect(info.source_url.startsWith("https://public.tableau.com/")).toBe(true);
    expect(info.workbook && info.author).toBeTruthy();
    expect(args.views.length).toBeGreaterThanOrEqual(1);
    expect(args.views.every((v: Doc) => v.name)).toBe(true);
    const narrative: string = doc.inputs[0].expected.insightNarrative;
    expect(narrative.length).toBeGreaterThanOrEqual(300);
    // The summary names the dashboard and most of the views it describes.
    expect(narrative).toContain(args.dashboardName);
    const low = narrative.toLowerCase();
    const named = args.views.filter((v: Doc) => low.includes(String(v.name).toLowerCase())).length;
    expect([replacement, named >= Math.floor(args.views.length / 2)]).toEqual([replacement, true]);
  }
});

test("the tool lists all 17 public dashboards", () => {
  const suites = listSuites({ publicBase: PUBLIC_ROOT });
  const pub = suites.find((s) => s.id === "dashboard-narratives-public")!;
  expect(pub.case_count).toBe(17);
  expect(pub.available).toBe(true);
});
