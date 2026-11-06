/**
 * The three Tableau AI features the evaluation tool evaluates, and the runner
 * categories nested under each (UX direction, 2026-08-15): the homepage
 * shows a section per feature with an expandable subsection per runner
 * category, and the results page's test-history panel is scoped to the
 * current run's feature.
 *
 * Mapping rule: prep runners → Tableau Agent in Tableau Prep, dashboard
 * narratives → Tableau Agent in Dashboards, everything else (viz authoring,
 * calc, palettes) → Tableau Agent in Authoring.
 *
 * Titles and descriptions are the ones the Tableau Server site settings page
 * shows under "AI Settings by Feature" (decision of 2026-09-24), so an admin
 * recognises each section as the feature they switched on there.
 */

export type FeatureKey = "viz" | "dashboards" | "prep";

export interface FeatureDef {
  key: FeatureKey;
  title: string;
  /** Short name for the test-history panel heading. */
  short: string;
  description: string;
}

export const FEATURES: FeatureDef[] = [
  {
    key: "viz",
    title: "Tableau Agent in Authoring",
    short: "Authoring",
    description:
      "Builds visualizations or completes tasks for you using a conversational UI",
  },
  {
    key: "dashboards",
    title: "Tableau Agent in Dashboards (Beta)",
    short: "Dashboards",
    description:
      "Delivers dashboard summaries and insights and lets users ask questions about their data using natural language",
  },
  {
    key: "prep",
    title: "Tableau Agent in Tableau Prep",
    short: "Tableau Prep",
    description: "Suggests steps to clean and transform your data",
  },
];

/** A capability of a feature: one expandable subsection on the homepage.
 *  Each is something the feature does for the user ("writes a formula from
 *  a request") and is tested by its own suite. Suites map in by their
 *  catalog `capability`; runs map in by ai_feature (the launch payload
 *  carries the suite capability) with runner_name as the fallback for
 *  API-submitted runs. The runner id is an implementation detail (dev-only
 *  in the UI). Labels name the capability, never the test method
 *  (decision of 2026-09-24). */
export interface CategoryDef {
  key: string;
  feature: FeatureKey;
  /** The capability, as a customer would name it. */
  label: string;
  /** What the test asks the AI to do, one clause, lower-case start. */
  task: string;
  capabilities: string[];
  runners: string[];
  /** Held back from this release: still maps its runs and suites to the
   *  feature, but the home page shows no chip for it. */
  held_back?: boolean;
}

export const CATEGORIES: CategoryDef[] = [
  { key: "calc", feature: "viz", label: "Calculated fields", task: "writes a formula from a request", capabilities: ["calc"], runners: ["calc-prompt"] },
  { key: "viz-authoring", feature: "viz", label: "Build a visualization", task: "turns a question into a chart", capabilities: ["viz-authoring"], runners: ["ect-server"] },
  { key: "palettes", feature: "viz", label: "Color palettes", task: "suggests a palette for a chart", capabilities: ["palettes"], runners: ["color-palettes-server"] },
  { key: "dashboard-narratives", feature: "dashboards", label: "Dashboard Narratives", task: "describes a dashboard in prose", capabilities: ["dashboard-narratives"], runners: ["dashboard-viz-narrative-config"] },
  { key: "dashboard-qa", feature: "dashboards", label: "Questions about a dashboard", task: "answers a question from the dashboard's data", capabilities: ["dashboard-qa"], runners: ["cabu-dashboard-qa"], held_back: true },
  { key: "prep-calc", feature: "prep", label: "Calculated fields in flows", task: "writes a formula for a flow step", capabilities: ["prep-calc"], runners: ["prep-calc-gen"] },
  { key: "prep-flow-plan", feature: "prep", label: "Plan a flow", task: "suggests the steps that clean and transform the data", capabilities: ["prep-flow-plan"], runners: ["prep-flow-plan-gen"] },
  { key: "prep-intent", feature: "prep", label: "Understand the request", task: "works out what the user asked for", capabilities: ["prep-intent"], runners: ["prep-intent-gen"] },
];

/** The feature a runner id belongs to: the capability table first, then
 *  the id's prefix for a runner the table does not list yet. */
export function featureOfRunner(runner: string | null | undefined): FeatureKey {
  const listed = CATEGORIES.find((c) => c.runners.includes(runner || ""));
  if (listed) return listed.feature;
  if (runner && runner.startsWith("prep-")) return "prep";
  if (runner && runner.startsWith("dashboard-")) return "dashboards";
  return "viz";
}

/** The feature a run belongs to. The capability the launch recorded
 *  (`ai_feature`) decides; the runner id is the fallback for a run
 *  submitted through the API without one. */
export function featureOfRun(r: {
  ai_feature?: string | null;
  runner_name?: string | null;
}): FeatureKey {
  const listed = CATEGORIES.find((c) => c.capabilities.includes(r.ai_feature || ""));
  return listed ? listed.feature : featureOfRunner(r.runner_name);
}

/** The feature a suite belongs to. The suite's capability id decides,
 *  through the same table that names the capability on the home page;
 *  the adapter id never does. (2026-10-20: a frontend that sorted the
 *  Prep suites by adapter id met a server that had renamed the adapter,
 *  so the three Prep suites joined the Authoring card and an Evaluate of
 *  Authoring queued six suites.) The prefixes stay for a capability the
 *  table does not list yet. */
export function featureOfSuite(s: {
  adapter?: string;
  capability?: string;
}): FeatureKey {
  const capability = s.capability || "";
  const listed = CATEGORIES.find((c) => c.capabilities.includes(capability));
  if (listed) return listed.feature;
  if (capability.startsWith("prep-")) return "prep";
  if (capability.startsWith("dashboard-")) return "dashboards";
  if (s.adapter === "prep_server") return "prep";
  return "viz";
}

export function featureDef(key: FeatureKey): FeatureDef {
  return FEATURES.find((f) => f.key === key) || FEATURES[0];
}

export function categoryOfSuite(s: { capability?: string }): CategoryDef {
  return (
    CATEGORIES.find((c) => c.capabilities.includes(s.capability || "")) ||
    CATEGORIES[1] // viz-authoring is the historical catch-all
  );
}

export function categoryOfRun(r: {
  ai_feature?: string;
  runner_name?: string;
}): CategoryDef {
  return (
    CATEGORIES.find((c) => c.capabilities.includes(r.ai_feature || "")) ||
    CATEGORIES.find((c) => c.runners.includes(r.runner_name || "")) ||
    CATEGORIES[1]
  );
}
