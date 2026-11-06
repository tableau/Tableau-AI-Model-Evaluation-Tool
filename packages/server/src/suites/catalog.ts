/** Shipped evaluation suites, resolved against injectable absolute content paths. */

import { basename, join } from "node:path";
import { contentIsDir, contentIsFile, contentReaddir, contentReadText } from "@tableau-ai-eval/core";
import { flattenPrepSuite, parseSuiteYaml, prepCasesBase } from "@tableau-ai-eval/evals";

// Conservative per-case runtime estimate (UI display only).
export const SECONDS_PER_CASE = 12;

export interface SuiteCatalogEntry {
  id: string;
  label: string;
  capability: string;
  runner: string;
  subdir: string;
  judge_capable: boolean;
  visibility: "public";
  root?: "public";
  adapter?: "prep_server" | "cabu" | "palettes" | "agent" | "narratives";
  ui_hidden?: boolean;
  /** The sample-content manifest id (public-suites/dashboard-qa/content.json). */
  content?: string;
  /** Public entries only: false hides the entry while its folder has no cases. */
  listed_when_empty?: boolean;
  /** Listed so the capability keeps its place, never runnable. */
  coming_soon?: boolean;
  /** The suite's own baseline, overriding its capability's. */
  baseline?: number;
  baseline_provisional?: boolean;
  parts?: string[];
}

export interface SuiteEntry {
  id: string;
  label: string;
  capability: string;
  runner: string;
  judge_capable: boolean;
  visibility: "public";
  adapter?: "prep_server" | "cabu" | "palettes" | "agent" | "narratives";
  ui_hidden?: boolean;
  /** The sample-content manifest id, for suites whose content the tool publishes. */
  content?: string;
  available: boolean;
  path: string | null;
  case_count: number;
  estimated_seconds: number;
  coming_soon?: boolean;
  /** Baseline overall score, 0-1 (null when none is known). */
  baseline?: number | null;
  /** True when the baseline is a provisional placeholder. */
  baseline_provisional?: boolean;
  /** Its requests go through the Tableau Server under test. */
  server_routed?: boolean;
  /** False when the connected server cannot run it (set by GET /nlq-eval/suites). */
  server_supported?: boolean;
  /** Why it cannot run on the connected server, else null. */
  server_message?: string | null;
  parts?: Array<{ id: string; label: string; content?: string; case_count: number }>;
}

/**
 * Injectable, absolute base directories. Any base may be null when the
   * corresponding content directory is not present (suite reports unavailable).
 */
export interface SuiteBases {
  /** `public-suites/` root (public catalog subdirs resolve here). */
  publicBase: string | null;
  /** The Prep suites' cases (public-suites/prep, or a named bench's test/test-cases). */
  prepBase?: string | null;
}

/**
 * Baseline headline score per capability, 0-1: what a well-supported model
 * reaches on the suite on the reference build. MEASURED on 2026-10-11 to
 * 2026-10-13 against a Tableau Server reference build
 * under three site models, claude-sonnet-4-6, gpt-5.5 and claude-sonnet-5,
 * embeddings text-embedding-3-small: each value is the median of the three,
 * rounded to a point. The UI colours a score green at or above its baseline,
 * "Little lower" up to 25 points below, "Much lower" beyond. Replace a value
 * here, or set `baseline` on a suite entry, and every surface that shows a
 * delta follows.
 */
export const MEASURED_BASELINES: Record<string, number> = {
  // the baseline table of 2026-10-29 (claude-sonnet-4-6 / claude-sonnet-5 / gpt-5.5).
  // The metric catalog's capability_baselines carries the same values for the
  // results page (a test keeps the two equal).
  "viz-authoring": 0.83, // 84 / 84 / 81
  calc: 0.85, // 85 / 84 / 85
  palettes: 0.88, // 87 / 89 / 88
  "dashboard-narratives": 0.88, // 87 / 88 / 89
  "dashboard-qa": 0.88, // 89 / 89 / 88
  // The Prep suites: agreed with the Tableau Prep team on 2026-10-22. The
  // runs through the server's own Prep pipeline (2026-10-14, claude-sonnet-4-6
  // only) measured calc 79.7, flow plan 80.5, intent 99.8. The catalog's
  // category_baselines_by_capability carries the same values so the results
  // page colours those categories' pills against them (a test keeps the two
  // equal).
  "prep-calc": 0.85,
  "prep-flow-plan": 0.8,
  "prep-intent": 0.95,
};

/**
 * PROVISIONAL baselines, labelled as such in the UI, for a capability that
 * has not been measured on the reference build. None today: every
 * capability has a measured value above.
 */
export const PROVISIONAL_BASELINES: Record<string, number> = {};

/**
 * Attach the suite's baseline (its own, else its capability's), and whether
 * its requests go through the Tableau Server under test.
 *
 * Every suite does today: the server's AI endpoint (or its palette and
 * dashboard Q&A endpoints) is the only way the model under test is reached,
 * so a server release without the endpoint can run none of them. The flag is
 * explicit in the catalog so the UI and the run request can disable exactly
 * the suites that need the server, and a future suite that does not can say
 * so with `server_routed: false`.
 */
export function withBaseline(suite: SuiteEntry): SuiteEntry {
  suite.server_routed ??= true;
  if (suite.baseline === undefined || suite.baseline === null) {
    const measured = MEASURED_BASELINES[suite.capability];
    if (measured !== undefined) {
      suite.baseline = measured;
      suite.baseline_provisional = false;
    } else {
      suite.baseline = PROVISIONAL_BASELINES[suite.capability] ?? null;
      suite.baseline_provisional = suite.baseline !== null;
    }
  } else if (suite.baseline_provisional === undefined) {
    suite.baseline_provisional = false;
  }
  return suite;
}

// ---- Public suites: tool-owned content under `public-suites/`. They carry
// the capability's labels, capabilities and runners. ----
export const PUBLIC_CATALOG: SuiteCatalogEntry[] = [
  {
    id: "dashboard-qa-public",
    label: "Questions about a dashboard",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases",
    // Each dashboard's data questions, then the questions about it that
    // expect a clarification or a refusal (its `-declines` part, 83 in all),
    // so one run asks both and the results page shows them together
    // (2026-11-04). A declines part asks about the same published
    // dashboard as its data part, so nothing is published twice.
    parts: [
      "dashboard-qa-insurance",
      "dashboard-qa-insurance-declines",
      "dashboard-qa-clv",
      "dashboard-qa-clv-declines",
      "dashboard-qa-hls",
      "dashboard-qa-hls-declines",
      "dashboard-qa-length-of-stay",
      "dashboard-qa-multi-datasource",
      "dashboard-qa-multi-datasource-declines",
      "dashboard-qa-ambiguous-fields",
      "dashboard-qa-ambiguous-fields-declines",
      "dashboard-qa-sales-pipeline",
      "dashboard-qa-sales-pipeline-declines",
      "dashboard-qa-product-revenue",
      "dashboard-qa-product-revenue-declines",
      "dashboard-qa-sales-crm",
      "dashboard-qa-sales-crm-declines",
      "dashboard-qa-customer-360",
      "dashboard-qa-customer-360-declines",
      "dashboard-qa-customer-service",
      "dashboard-qa-transactions",
      "dashboard-qa-transactions-declines",
      "dashboard-qa-marketing",
      "dashboard-qa-marketing-declines",
      "dashboard-qa-superstore",
      "dashboard-qa-california-schools",
    ],
    judge_capable: true,
    visibility: "public",
  },
  {
    id: "viz-authoring-public",
    adapter: "agent",
    label: "Build a visualization",
    capability: "viz-authoring",
    runner: "ect-server",
    root: "public",
    subdir: "vizgen/cases",
    judge_capable: true,
    visibility: "public",
  },
  {
    id: "calcs-public",
    adapter: "agent",
    label: "Calculated fields",
    capability: "calc",
    runner: "ect-server",
    root: "public",
    subdir: "calcs/cases",
    judge_capable: true,
    visibility: "public",
  },
  {
    // The cases ask about no dataset, so they ship as they are (same id as
    // before: the content did not change). Served by the tool's own palette
    // adapter (`@tableau-ai-eval/evals` adapters/palettes.ts): no evaluator checkout
    // is required.
    id: "color-palette",
    label: "Color palettes",
    capability: "palettes",
    runner: "color-palettes-server",
    adapter: "palettes",
    root: "public",
    subdir: "color-palette/cases",
    // Palettes have no reply, but the tool scores the palette rubric
    // (valid / relevance / design) with the configured judge.
    judge_capable: true,
    visibility: "public",
  },
  // ---- Questions about a dashboard (Tableau Agent in Dashboards). The cases
  // use public data: Tableau training files, two UCI Machine Learning
  // Repository sets, the TC26 Data Depot demo CRM, Tableau's Superstore and the
  // BIRD benchmark. Nothing is generated.
  // Every ground truth is computed from the shipped sample data
  // (public-suites/dashboard-qa/ground-truth). Each file is one suite, and
  // public-suites/dashboard-qa/content.json names the sample dashboard and
  // data source(s) it asks about (`content` is the manifest id). The tool
  // publishes that content to the connected site on request and fills the
  // PLACEHOLDER ids from what it published. The tool's own adapter drives the
  // server's dashboard Q&A API; answer quality is scored by the judge.
  // One-case smoke copies stay off the UI but keep their suite id so an API
  // caller can check a site quickly.
  {
    // 22 questions about an auto insurance claims dashboard (17,000 claims, Tableau training data).
    id: "dashboard-qa-insurance",
    label: "Auto Insurance Claims",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_auto_insurance.yml",
    content: "dashboard-qa-insurance",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 16 questions about an online retail dashboard with lifetime-value calculations (1,067,371 invoice lines, UCI Online Retail II).
    id: "dashboard-qa-clv",
    label: "Customer Lifetime Value",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_clv.yml",
    content: "dashboard-qa-clv",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 62 questions about an inpatient stays dashboard (11,188 stays, Tableau training data).
    id: "dashboard-qa-hls",
    label: "Hospital Stays",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_hospital_stays.yml",
    content: "dashboard-qa-hls",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 9 questions that need a field filter on a payer claims dashboard (154,890 claims, Tableau training data).
    id: "dashboard-qa-length-of-stay",
    label: "Payer Claims",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_payer_claims.yml",
    content: "dashboard-qa-length-of-stay",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 38 of the insurance and lifetime-value questions asked of one dashboard that holds both data sources: the agent has to pick the right one.
    id: "dashboard-qa-multi-datasource",
    label: "Two Data Sources",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_two_sources.yml",
    content: "dashboard-qa-multi-datasource",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 5 questions about the same two data sources with look-alike field names; the 43 that should ask which field is meant are in the declines suite.
    id: "dashboard-qa-ambiguous-fields",
    label: "Ambiguous Field Names",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_ambiguous_fields.yml",
    content: "dashboard-qa-ambiguous-fields",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 67 questions about a sales pipeline dashboard (2,944 Data Depot opportunities): closed-won amounts, open pipeline, fiscal periods, owner hierarchy.
    id: "dashboard-qa-sales-pipeline",
    label: "Sales Pipeline",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_sales_pipeline.yml",
    content: "dashboard-qa-sales-pipeline",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 59 questions about top products by revenue, by state and period (7,329 Data Depot opportunity lines).
    id: "dashboard-qa-product-revenue",
    label: "Product Revenue",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_product_revenue.yml",
    content: "dashboard-qa-product-revenue",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 66 questions about a CRM dashboard with three data sources: opportunities, accounts and contacts, support cases.
    id: "dashboard-qa-sales-crm",
    label: "Sales CRM",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_sales_crm.yml",
    content: "dashboard-qa-sales-crm",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 66 questions about a customer dashboard with four data sources: opportunities, cases, store orders, accounts and contacts.
    id: "dashboard-qa-customer-360",
    label: "Customer 360",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_customer_360.yml",
    content: "dashboard-qa-customer-360",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 26 questions about a support cases dashboard (2,411 Data Depot cases), two of them open-ended overviews.
    id: "dashboard-qa-customer-service",
    label: "Customer Service",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_customer_service.yml",
    content: "dashboard-qa-customer-service",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 7 questions about a purchases-and-refunds dashboard (29,537 Data Depot transactions).
    id: "dashboard-qa-transactions",
    label: "Transactions",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_transactions.yml",
    content: "dashboard-qa-transactions",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 27 questions about a telemarketing campaign dashboard (41,188 bank contacts, UCI Bank Marketing).
    id: "dashboard-qa-marketing",
    label: "Bank Marketing",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_bank_marketing.yml",
    content: "dashboard-qa-marketing",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 13 questions whose answers follow the business preferences supplied with the dashboard (six Data Depot data sources).
    // HELD BACK from the combined suite (2026-11-03): the dashboard Q&A API has no way to
    // pass business preferences, so the server never sees them and the questions cannot
    // be answered as expected. Still runnable by id through the API; a feature request
    // for the API is with the CABU product manager.
    id: "dashboard-qa-business-preferences",
    ui_hidden: true,
    label: "Business Preferences",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_business_preferences.yml",
    content: "dashboard-qa-business-preferences",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 422 questions about a Superstore Orders dashboard (the questions of the other suites rephrased for Superstore).
    id: "dashboard-qa-superstore",
    label: "Superstore Orders",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_superstore.yml",
    content: "dashboard-qa-superstore",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 31 questions from the public BIRD benchmark's California Schools database (its thirty mini-dev questions and a warm-up),
    // asked of a dashboard over its three tables as three pairwise-related data sources (bird_mini, 2026-11-04).
    id: "dashboard-qa-california-schools",
    label: "California Schools",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_california_schools.yml",
    content: "dashboard-qa-california-schools",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 43 questions of the Ambiguous Field Names dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-ambiguous-fields-declines",
    label: "Ambiguous Field Names (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_ambiguous_fields_declines.yml",
    content: "dashboard-qa-ambiguous-fields",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 5 questions of the Auto Insurance Claims dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-insurance-declines",
    label: "Auto Insurance Claims (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_auto_insurance_declines.yml",
    content: "dashboard-qa-insurance",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 1 question of the Bank Marketing dashboard that expects a clarification or a refusal.
    id: "dashboard-qa-marketing-declines",
    label: "Bank Marketing (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_bank_marketing_declines.yml",
    content: "dashboard-qa-marketing",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 5 questions of the Customer Lifetime Value dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-clv-declines",
    label: "Customer Lifetime Value (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_clv_declines.yml",
    content: "dashboard-qa-clv",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 4 questions of the Customer 360 dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-customer-360-declines",
    label: "Customer 360 (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_customer_360_declines.yml",
    content: "dashboard-qa-customer-360",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 6 questions of the Hospital Stays dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-hls-declines",
    label: "Hospital Stays (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_hospital_stays_declines.yml",
    content: "dashboard-qa-hls",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 5 questions of the Product Revenue dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-product-revenue-declines",
    label: "Product Revenue (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_product_revenue_declines.yml",
    content: "dashboard-qa-product-revenue",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 1 question of the Sales CRM dashboard that expects a clarification or a refusal.
    id: "dashboard-qa-sales-crm-declines",
    label: "Sales CRM (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_sales_crm_declines.yml",
    content: "dashboard-qa-sales-crm",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 2 questions of the Sales Pipeline dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-sales-pipeline-declines",
    label: "Sales Pipeline (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_sales_pipeline_declines.yml",
    content: "dashboard-qa-sales-pipeline",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 1 question of the Transactions dashboard that expects a clarification or a refusal.
    id: "dashboard-qa-transactions-declines",
    label: "Transactions (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_transactions_declines.yml",
    content: "dashboard-qa-transactions",
    judge_capable: true,
    visibility: "public",
  },
  {
    // 10 questions of the Two Data Sources dashboard that expect a clarification or a refusal.
    id: "dashboard-qa-multi-datasource-declines",
    label: "Two Data Sources (declines)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_two_sources_declines.yml",
    content: "dashboard-qa-multi-datasource",
    judge_capable: true,
    visibility: "public",
  },
  {
    id: "dashboard-qa-insurance-smoke",
    label: "Auto Insurance Claims (smoke)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_auto_insurance_smoke.yml",
    content: "dashboard-qa-insurance-smoke",
    judge_capable: true,
    visibility: "public",
    ui_hidden: true,
  },
  {
    id: "dashboard-qa-superstore-smoke",
    label: "Superstore Orders (smoke)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_superstore_smoke.yml",
    content: "dashboard-qa-superstore-smoke",
    judge_capable: true,
    visibility: "public",
    ui_hidden: true,
  },
  {
    id: "dashboard-qa-california-schools-smoke",
    label: "California Schools (smoke)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_california_schools_smoke.yml",
    content: "dashboard-qa-california-schools-smoke",
    judge_capable: true,
    visibility: "public",
    ui_hidden: true,
  },
  {
    id: "dashboard-qa-multi-turn-smoke",
    label: "Customer Service (multi-turn smoke)",
    capability: "dashboard-qa",
    runner: "cabu-dashboard-qa",
    adapter: "cabu",
    root: "public",
    subdir: "dashboard-qa/cases/cabu_public_multi_turn_smoke.yml",
    content: "dashboard-qa-multi-turn-smoke",
    judge_capable: true,
    visibility: "public",
    ui_hidden: true,
  },
  {
    // Dashboard summaries on dashboards cleared for release. The folder ships
    // empty until such cases exist, and the entry is not listed while it is:
    // the capability keeps its "coming soon" placeholder.
    id: "dashboard-narratives-public",
    adapter: "narratives",
    label: "Dashboard Narratives",
    capability: "dashboard-narratives",
    runner: "dashboard-viz-narrative-config",
    root: "public",
    subdir: "dashboard-narratives/cases",
    judge_capable: true,
    visibility: "public",
    listed_when_empty: false,
  },
];

// Individual dashboard suites stay addressable for old runs and API callers;
// the home page offers their combined suite instead.
for (const id of PUBLIC_CATALOG.find(entry => entry.id === "dashboard-qa-public")!.parts!) {
  PUBLIC_CATALOG.find(entry => entry.id === id)!.ui_hidden = true;
}

export interface SuitePart {
  id: string;
  label: string;
  key: string;
  content?: string;
  path: string;
  case_count: number;
}

/** Each combined-suite question retains the content and identity of its part. */
export function partsOf(suiteId: string, publicBase: string | null): SuitePart[] {
  const entry = PUBLIC_CATALOG.find(entry => entry.id === suiteId);
  if (!entry?.parts || !publicBase) return [];
  return entry.parts.flatMap(id => {
    const member = PUBLIC_CATALOG.find(entry => entry.id === id);
    if (!member) return [];
    const path = join(publicBase, member.subdir);
    return [{ id, label: member.label, key: id.replace(/^dashboard-qa-/, ""), content: member.content, path, case_count: isFile(path) ? countCabuCases(path) : 0 }];
  });
}

/** The catalog wins over stale adapter names sent by a page loaded earlier. */
export function adapterFor(suiteId: string): string | undefined {
  return [...PUBLIC_CATALOG, ...CATALOG].find(entry => entry.id === suiteId)?.adapter;
}



/**
 * What a run's suite is called today: the catalog's current name for its
 * suite id, falling back to the label stored at launch. Suites were renamed
 * after the capability chips, so older runs carry the old name in
 * their config; resolving at read time keeps the run history, the results
 * page and exports on the current names.
 */
export function displayLabel(
  suiteId: unknown,
  stored: unknown,
): string | null {
  if (suiteId) {
    const label = suiteLabelFor(String(suiteId));
    if (label) return label;
  }
  return (stored as string) || null;
}

/**
 * The catalog's human-readable name for a suite id ("Calculated fields"),
 * or null when the id is unknown. Used to label runs launched with a suite id
 * but no label (API callers), so the results page never has to fall back to the
 * runner id.
 */
/**
 * The case file or directory a catalog suite runs from, as the suites list
 * reports it, or null when the id is unknown or its cases are not on this
 * machine. An API caller may name a suite by id alone; the page sends the
 * path it was listed with. Without this a Questions about a dashboard member
 * named by id would fall back to the adapter's default file.
 */
export function suitePathFor(suiteId: string, bases: SuiteBases): string | null {
  const suite = listSuites(bases).find((s) => s.id === suiteId);
  return suite?.path || null;
}

export function suiteLabelFor(suiteId: string): string | null {
  for (const entry of [...PUBLIC_CATALOG, ...CATALOG]) {
    if (entry.id === suiteId) return entry.label;
  }
  return null;
}

export const CATALOG: SuiteCatalogEntry[] = [
  // Shipped Prep suites.
  {
    id: "prep-calc-gen",
    label: "Calculated fields in flows",
    capability: "prep-calc",
    runner: "prep-calc-gen",
    adapter: "prep_server",
    subdir: "calc-gen",
    judge_capable: true,
    visibility: "public",
  },
  {
    id: "prep-flow-plan-gen",
    label: "Plan a flow",
    capability: "prep-flow-plan",
    runner: "prep-flow-plan-gen",
    adapter: "prep_server",
    subdir: "flow-plan-gen",
    judge_capable: false,
    visibility: "public",
  },
  {
    id: "prep-intent-gen",
    label: "Understand the request",
    capability: "prep-intent",
    runner: "prep-intent-gen",
    adapter: "prep_server",
    subdir: "intent-gen",
    judge_capable: false,
    visibility: "public",
  },
];

/** Surfaced, non-silent catalog issues the port has to keep visible. */
export const CATALOG_KNOWN_ISSUES = [] as const;

/**
 * Count runnable test cases under a suite directory (recursive — some suites
 * nest by datasource). A file is one conversation; each entry of its `inputs`
 * list is one test case. Files that cannot be read still count as one case, so
 * a malformed file never makes a suite look empty.
 */
export function countCases(pathStr: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = contentReaddir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (contentIsDir(full)) {
        walk(full);
      } else if (name.endsWith(".json")) {
        try {
          const doc = JSON.parse(contentReadText(full));
          const inputs =
            doc && typeof doc === "object" ? doc.inputs : undefined;
          count +=
            Array.isArray(inputs) && inputs.length > 0 ? inputs.length : 1;
        } catch {
          count += 1;
        }
      }
    }
  };
  walk(pathStr);
  return count;
}

const isDir = contentIsDir;
const isFile = contentIsFile;

/**
 * CABU suites are single YAML files — count runnable cases the way the
 * adapter will (0 when the file does not parse).
 */
export function countCabuCases(pathStr: string): number {
  try {
    return parseSuiteYaml(contentReadText(pathStr), pathStr).length;
  } catch {
    return 0;
  }
}

/**
 * Prep suites are YAML files with multiple utterances per test — count
 * runnable records the way the adapter will.
 */
export function countPrepCases(pathStr: string): number {
  const kind = basename(pathStr) as "calc-gen" | "flow-plan-gen" | "intent-gen";
  if (!["calc-gen", "flow-plan-gen", "intent-gen"].includes(kind)) return 0;
  try {
    return flattenPrepSuite(pathStr, kind, undefined, true).length;
  } catch {
    return 0;
  }
}

/**
 * Public catalog entries with live availability.
 * A cabu entry is one YAML file; the rest are JSON-case dirs. An entry with
 * `listed_when_empty: false` is left out while it has no cases.
 */
/**
 * Capabilities held back from this release. Their catalog entries, adapter and
 * tests stay in place so the suite returns with a one-line change; the listing
 * leaves them out and the home page shows no capability for them.
 * Questions about a dashboard (2026-11-06): its content folder is out of the
 * tree while the licence of one sample dataset is confirmed.
 */
export const HELD_BACK_CAPABILITIES: ReadonlySet<string> = new Set(["dashboard-qa"]);

export function publicEntries(bases: SuiteBases): SuiteEntry[] {
  const base = bases.publicBase;
  const out: SuiteEntry[] = [];
  for (const entry of PUBLIC_CATALOG) {
    if (HELD_BACK_CAPABILITIES.has(entry.capability)) continue;
    const path = base ? join(base, entry.subdir) : null;
    let count = 0;
    const parts = partsOf(entry.id, base);
    if (entry.parts) {
      count = parts.reduce((sum, part) => sum + part.case_count, 0);
    } else if (path !== null && entry.adapter === "cabu") {
      count = isFile(path) ? countCabuCases(path) : 0;
    } else {
      count = path !== null && isDir(path) ? countCases(path) : 0;
    }
    if (count === 0 && entry.listed_when_empty === false) continue;
    if (entry.coming_soon) {
      // Listed so the capability keeps its place, never runnable.
      out.push({
        id: entry.id,
        label: entry.label,
        capability: entry.capability,
        runner: entry.runner,
        judge_capable: entry.judge_capable,
        visibility: entry.visibility,
        ...(entry.adapter ? { adapter: entry.adapter } : {}),
        ...(entry.ui_hidden ? { ui_hidden: entry.ui_hidden } : {}),
        ...(entry.content ? { content: entry.content } : {}),
        ...(entry.baseline !== undefined ? { baseline: entry.baseline } : {}),
        ...(entry.baseline_provisional !== undefined ? { baseline_provisional: entry.baseline_provisional } : {}),
        available: false,
        path: null,
        case_count: 0,
        estimated_seconds: 0,
        coming_soon: true,
      });
      continue;
    }
    out.push({
      id: entry.id,
      label: entry.label,
      capability: entry.capability,
      runner: entry.runner,
      judge_capable: entry.judge_capable,
      visibility: entry.visibility,
      ...(entry.adapter ? { adapter: entry.adapter } : {}),
      ...(entry.ui_hidden ? { ui_hidden: entry.ui_hidden } : {}),
      ...(entry.content ? { content: entry.content } : {}),
      ...(entry.parts ? { parts: parts.map(({ id, label, content, case_count }) => ({ id, label, content, case_count })) } : {}),
      ...(entry.baseline !== undefined ? { baseline: entry.baseline } : {}),
      ...(entry.baseline_provisional !== undefined ? { baseline_provisional: entry.baseline_provisional } : {}),
      available: count > 0,
      path: count > 0 ? path : null,
      case_count: count,
      estimated_seconds: count * SECONDS_PER_CASE,
    });
  }
  return out;
}

/** Shipped Prep suites with live availability and case counts. */
export function listPrepSuites(bases: SuiteBases): SuiteEntry[] {
  const prepBase = bases.prepBase === undefined ? prepCasesBase() : bases.prepBase;
  const out: SuiteEntry[] = [];
  for (const entry of CATALOG) {
    const path = prepBase ? join(prepBase, entry.subdir) : null;

    const present =
      path !== null && isDir(path);
    let available = false;
    let count = 0;
    let resolvedPath: string | null = null;
    if (present && path !== null) {
      count = countPrepCases(path);
      available = count > 0;
      resolvedPath = available ? path : null;
    }
    out.push({
      id: entry.id,
      label: entry.label,
      capability: entry.capability,
      runner: entry.runner,
      judge_capable: entry.judge_capable,
      visibility: entry.visibility,
      ...(entry.adapter ? { adapter: entry.adapter } : {}),
      ...(entry.ui_hidden ? { ui_hidden: entry.ui_hidden } : {}),
      available,
      path: resolvedPath,
      case_count: count,
      estimated_seconds: count * SECONDS_PER_CASE,
    });
  }
  return out;
}

/** Shipped suites. */
export function listSuites(
  bases: SuiteBases,
): SuiteEntry[] {
  return [...publicEntries(bases), ...listPrepSuites(bases)].map(withBaseline);
}
