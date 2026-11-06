import { test, expect, beforeAll, afterAll } from "bun:test";
import { metricCatalog } from "@tableau-ai-eval/core";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, HELD_BACK_CAPABILITIES, MEASURED_BASELINES, PUBLIC_CATALOG, SECONDS_PER_CASE, countCases, listPrepSuites, listSuites, publicEntries, suiteLabelFor, suitePathFor, type SuiteBases, type SuiteEntry, withBaseline } from "./catalog.ts";

const ROOT = join(tmpdir(), `tableau-ai-eval-suites-fixture-${process.pid}`);
// A public-suites-shaped tree.
const PUBLIC_BASE = join(ROOT, "public-suites");

function writeJson(path: string, obj: unknown) {
  writeFileSync(path, JSON.stringify(obj));
}

beforeAll(() => {
  // public-suites/calcs/cases with 2 files (1 + 3 inputs = 4 cases)
  mkdirSync(join(PUBLIC_BASE, "calcs", "cases"), { recursive: true });
  writeJson(join(PUBLIC_BASE, "calcs", "cases", "a.json"), { inputs: [{}] });
  writeJson(join(PUBLIC_BASE, "calcs", "cases", "b.json"), { inputs: [{}, {}, {}] });
  // public-suites/vizgen/cases with 2 cases
  mkdirSync(join(PUBLIC_BASE, "vizgen", "cases"), { recursive: true });
  writeJson(join(PUBLIC_BASE, "vizgen", "cases", "v.json"), { inputs: [{}, {}] });
  // NOTE: deliberately NO public-suites/sample-calcs — that's the flagged mismatch.

});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

test("countCases: counts inputs entries recursively, malformed = 1", () => {
  const d = join(ROOT, "count-fixture");
  mkdirSync(join(d, "nested"), { recursive: true });
  writeJson(join(d, "one.json"), { inputs: [{}] });
  writeJson(join(d, "nested", "three.json"), { inputs: [{}, {}, {}] });
  writeJson(join(d, "no_inputs.json"), { id: "x" });
  writeFileSync(join(d, "broken.json"), "{not json");
  expect(countCases(d)).toBe(1 + 3 + 1 + 1);
});

test("public catalog: id->dir resolution + availability", () => {
  const bases: SuiteBases = { publicBase: PUBLIC_BASE };
  const entries = publicEntries(bases);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const calcs = byId.get("calcs-public")!;
  expect(calcs.available).toBe(true);
  expect(calcs.case_count).toBe(4);
  expect(calcs.path).toBe(join(PUBLIC_BASE, "calcs/cases"));
  expect(calcs.estimated_seconds).toBe(4 * SECONDS_PER_CASE);

  const viz = byId.get("viz-authoring-public")!;
  expect(viz.available).toBe(true);
  expect(viz.case_count).toBe(2);

  // Multi-step planning is not a shipped suite.
  expect(byId.has("multistep-plan-public")).toBe(false);
});

test("only shipped Prep suites are in the supplementary catalog", () => {
  const bases: SuiteBases = {
    publicBase: PUBLIC_BASE,
    prepBase: null,
  };
  const prep = listPrepSuites(bases);
  const byId = new Map(prep.map((e) => [e.id, e]));

  expect([...byId.keys()].sort()).toEqual(["prep-calc-gen", "prep-flow-plan-gen", "prep-intent-gen"]);

  // adapter-only suites resolve unavailable without a prep/cabu base.
  const calc = byId.get("prep-calc-gen")!;
  expect(calc.adapter).toBe("prep_server");
  expect(calc.available).toBe(false);
  expect(calc.path).toBe(null);
});

test("no unavailable private catalog entries are advertised", () => {
  const prep = listPrepSuites({
    publicBase: PUBLIC_BASE,
  });
  expect(prep.every((e) => e.visibility === "public")).toBe(true);
});

test("listSuites: only shipped suites are listed", () => {
  const bases: SuiteBases = { publicBase: PUBLIC_BASE };
  const suites = listSuites(bases);
  const byId = new Map(suites.map((s) => [s.id, s]));
  // public suites present
  expect(byId.has("calcs-public")).toBe(true);
  // Unshipped suites are never surfaced.
  expect(byId.has("sample-calcs")).toBe(false);
  // every suite is public-visible in this mode
  for (const s of suites) expect(s.visibility).toBe("public");
});

test("listSuites: unavailable suites are not advertised", () => {
  const bases: SuiteBases = {
    publicBase: PUBLIC_BASE,
  };
  const suites = listSuites(bases);
  const byId = new Map(suites.map((s) => [s.id, s]));
  expect(byId.has("testbench")).toBe(false);
  expect(byId.has("dashboard-narratives")).toBe(false);
  expect(suites.every((s) => s.visibility === "public")).toBe(true);
});



test("suiteLabelFor: catalog name for a known id, null for unknown", () => {
  // Known public id resolves to the customer-facing label.
  expect(suiteLabelFor("calcs-public")).toBe("Calculated fields");
  expect(suiteLabelFor("calcs")).toBeNull();
  // An unknown id leaves the caller to fall back (route keeps label empty).
  expect(suiteLabelFor("no-such-suite")).toBeNull();
});

// ---------------------------------------------------------------------------
// Color palettes ships with the tool: listed as public content,
// served from public-suites/color-palette/cases by the palettes adapter.
// ---------------------------------------------------------------------------

const REPO_PUBLIC = join(import.meta.dir, "..", "..", "..", "..", "public-suites");

test("the palette suite is public content from the tool's own folder", () => {
  const suites = listSuites({ publicBase: REPO_PUBLIC });
  const palette = suites.find((s) => s.id === "color-palette")!;
  expect(palette.available).toBe(true);
  expect(palette.case_count).toBe(34);
  expect(palette.visibility).toBe("public");
  expect(palette.coming_soon).toBeUndefined();
  expect(palette.adapter).toBe("palettes");
  expect(palette.path).toContain("public-suites");
  expect(palette.judge_capable).toBe(true);
  // Not listed twice, and never from the supplementary Prep catalog.
  expect(suites.filter((s) => s.id === "color-palette").length).toBe(1);
  expect(CATALOG.some((e) => e.id === "color-palette")).toBe(false);
});

// ---------------------------------------------------------------------------
// Tableau Agent in Dashboards: Questions about a dashboard is held back from
// this release (its catalog entries stay; see HELD_BACK_CAPABILITIES), so no
// dashboard-qa suite is listed and the Dashboards feature offers Dashboard
// Narratives alone. Dashboard Narratives appears once its public folder holds
// a case.
// ---------------------------------------------------------------------------

test("Questions about a dashboard is held back: no dashboard-qa suite is listed", () => {
  expect(HELD_BACK_CAPABILITIES.has("dashboard-qa")).toBe(true);
  const listed = listSuites({ publicBase: REPO_PUBLIC });
  expect(listed.filter((s) => s.capability === "dashboard-qa")).toEqual([]);
  expect(listed.some((s) => s.adapter === "cabu")).toBe(false);
  // The entries themselves are still in the catalog, ready to come back.
  expect(PUBLIC_CATALOG.find((e) => e.id === "dashboard-qa-public")?.parts?.length).toBe(26);
});

// The Dashboard Narratives folder holds the shipped public suite, so the
// capability is runnable and no placeholder is listed.
test("Dashboard Narratives ships as a public suite with no placeholder", () => {
  const byId = new Map(listSuites({ publicBase: REPO_PUBLIC }).map((s) => [s.id, s]));
  const s = byId.get("dashboard-narratives-public")!;
  expect(s.available).toBe(true);
  expect(s.case_count).toBe(17);
  expect(s.label).toBe("Dashboard Narratives");
  expect(s.runner).toBe("dashboard-viz-narrative-config");
  expect(s.path).toContain("public-suites");
  expect(byId.has("dashboard-narratives")).toBe(false);
  expect([...byId.values()].every((v) => v.visibility === "public")).toBe(true);
});

// The Prep suites' cases ship in public-suites/prep; their flows and step data in prep-bench/.
test("the Prep suites ship with the tool", () => {
  const byId = new Map(listSuites({ publicBase: REPO_PUBLIC }).map((s) => [s.id, s]));
  for (const [sid, cases] of [
    ["prep-calc-gen", 43],
    ["prep-flow-plan-gen", 47],
    ["prep-intent-gen", 564],
  ] as const) {
    const s = byId.get(sid)!;
    expect([s.available, s.coming_soon, s.case_count, s.visibility, s.adapter]).toEqual([
      true,
      undefined,
      cases,
      "public",
      "prep_server",
    ]);
  }
  expect(byId.get("prep-calc-gen")!.path!.endsWith("calc-gen")).toBe(true);
});

test("the public Dashboard Narratives suite appears once it has cases", () => {
  const root = join(ROOT, "public-with-summaries");
  const cases = join(root, "dashboard-narratives", "cases");
  mkdirSync(cases, { recursive: true });
  writeJson(join(cases, "one.json"), {
    id: "dn-1",
    runner: "dashboard-viz-narrative-config",
    inputs: [{ arguments: { dashboardName: "A", dashboardId: "A", views: [], dashboardArtifacts: [] },
               expected: { insightNarrative: "x" } }],
  });
  const byId = new Map(listSuites({ publicBase: root }).map((s) => [s.id, s]));
  const s = byId.get("dashboard-narratives-public")!;
  expect(s.available).toBe(true);
  expect(s.case_count).toBe(1);
  expect(s.label).toBe("Dashboard Narratives");
  expect(byId.has("dashboard-narratives")).toBe(false); // no placeholder beside the real suite
  expect("listed_when_empty" in s).toBe(false);
});



// Runs again when the held-back Questions about a dashboard content is back in the tree.
test.skipIf(!existsSync(join(REPO_PUBLIC, "dashboard-qa")))("a member suite named by id alone resolves to its own case file (2026-10-21)", () => {
  const bases = { publicBase: REPO_PUBLIC };
  // Compared with forward slashes so the assertion reads the same on Windows.
  const found = suitePathFor("dashboard-qa-insurance", bases)!.split("\\").join("/");
  expect(found.endsWith("dashboard-qa/cases/cabu_public_auto_insurance.yml")).toBe(true);
  expect(suitePathFor("no-such-suite", bases)).toBeNull();
});

test("every capability's baseline is the one the results page colours against (2026-10-29)", () => {
  const byCap = metricCatalog.loadCatalog().capability_baselines;
  expect(byCap).toEqual(MEASURED_BASELINES);
  expect(byCap).toEqual({
    "viz-authoring": 0.83,
    calc: 0.85,
    palettes: 0.88,
    "dashboard-narratives": 0.88,
    "dashboard-qa": 0.88,
    "prep-intent": 0.95,
    "prep-calc": 0.85,
    "prep-flow-plan": 0.8,
  });
  for (const [cap, value] of Object.entries(byCap!)) {
    const suite = withBaseline({ capability: cap } as Partial<SuiteEntry> as SuiteEntry);
    expect(suite.baseline).toBe(value);
    expect(suite.baseline_provisional).toBe(false);
  }
});

test("the Prep categories are coloured against their suites' baselines (2026-10-22)", () => {
  // Agreed with the Tableau Prep team: Calculated fields in flows 85, Flow plan
  // quality 80, Intent and spec 95. The results page colours those categories'
  // pills against them, so they have to stay the baselines the home page reads
  // the suites against.
  const byCap = metricCatalog.loadCatalog().category_baselines_by_capability;
  expect(byCap).toEqual({
    "prep-calc": { calc: 0.85 },
    "prep-flow-plan": { flowPlan: 0.8 },
    "prep-intent": { match: 0.95 },
  });
  const keys = new Set(metricCatalog.categories().map((c) => c.key));
  for (const [cap, perCategory] of Object.entries(byCap!)) {
    for (const [key, value] of Object.entries(perCategory)) {
      expect(keys.has(key)).toBe(true);
      expect(MEASURED_BASELINES[cap]).toBe(value);
      const suite = withBaseline({ capability: cap } as Partial<SuiteEntry> as SuiteEntry);
      expect(suite.baseline).toBe(value);
      expect(suite.baseline_provisional).toBe(false);
    }
  }
});
