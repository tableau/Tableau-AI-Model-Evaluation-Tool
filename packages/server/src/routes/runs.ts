/**
 * Run lifecycle + results route handlers for NLQ-eval.
 *
 * Split out of the old `routes/nlq_eval.ts` god-module (T4.2). Each handler is a
 * plain function taking the shared `RoutesContext` first, then the request bits
 * it needs. Behavior is byte-for-byte identical to the former closures — only
 * the closed-over locals are now reached via `ctx`.
 *
 * Group: getSuites, getDatasets, getDatasetById, getRuns, postRun, getStatus, getResults, getResultsClassic,
 * getExport, postPublish, postCancel, postPause, postResume, deleteResults,
 * streamEvents. (The run/results surface.)
 */

import { join } from "node:path";
import { isRedacted } from "@tableau-ai-eval/core";
import { runNlqEvalJob } from "../job/orchestrator.ts";
import { getAdapter } from "@tableau-ai-eval/core";
import * as catalog from "../suites/catalog.ts";
import * as publicContent from "../suites/public_content.ts";
import * as dashboardCases from "../suites/dashboard_cases.ts";
import { getPrepDataset, listPrepDatasets } from "../suites/prep_datasets.ts";
import { dashboardDatasetFile, getDashboardDataset, listDashboardDatasets } from "../suites/dashboard_content.ts";
import { readExtractRows } from "../suites/extract_rows.ts";
import { buildExportFromData, filenameStem, toCsv } from "../publish/export.ts";
import { buildRunBundleFromData } from "../publish/records.ts";
import {
  publishRun,
  DEFAULT_PROJECT,
  DEFAULT_DATASOURCE,
  HttpError,
  SchemaMismatch,
} from "../publish/hyper.ts";
import { TableauAuthError } from "@tableau-ai-eval/core";
import { detectFamily } from "@tableau-ai-eval/core";
import {
  probeServerinfo,
  serverVersionLabel,
} from "@tableau-ai-eval/core";
import { VERSION } from "../app.ts";
import { json, readJson, unknownJob, type RoutesContext } from "./context.ts";
import { mergeDashboardContent } from "./dashboard_content.ts";

const HEARTBEAT_SECS = Number(process.env.STREAM_HEARTBEAT_SECS ?? "12");
const LIVE_POLL_SECS = Number(process.env.STREAM_POLL_SECS ?? "0.5");

/** The status carried by a stored `done` event line ("" if unreadable). */
function doneStatus(payload: string): string {
  try {
    return String((JSON.parse(payload) as Record<string, unknown>).status ?? "");
  } catch {
    return "";
  }
}

/**
 * Customer path: LLM traffic goes through the Tableau Server, not a local
 * `llm_key`/`gateway_url`. Cabu talks to the CABU API on that server and the
 * palette suite to its palette endpoint; ces mode uses the embedded generations
 * bridge, which fills those fields when the job starts.
 */
function usesTableauGateway(config: Record<string, unknown>): boolean {
  const adapter = String(config.adapter ?? "").toLowerCase();
  if (["cabu", "palettes", "narratives", "agent", "prep_server"].includes(adapter)) return true;
  return String(config.generations_mode ?? "").toLowerCase() === "ces";
}

/**
 * Suites whose requests the server gates on the Tableau Agent in Authoring
 * site setting: Build a visualization and Calculated fields (the Agent) and
 * Color palettes.
 */
export function needsWebAuthoring(adapter: unknown): boolean {
  return ["agent", "palettes"].includes(String(adapter || "").toLowerCase());
}

/**
 * Whether the Tableau Agent in Dashboards verdict keeps this adapter's suites
 * out. Questions about a dashboard (cabu) always: the verdict is its
 * endpoint's own answer. Dashboard Narratives (narratives) when the site
 * switch is off (decision of 2026-11-04: the feature is one switch, so its whole
 * card is disabled), but not when the build merely lacks the Q&A endpoint
 * (`not_found`), which says nothing about narratives.
 */
export function gatedByDashboardsSwitch(adapter: unknown, qaOff: { reason?: string } | null): boolean {
  if (!qaOff) return false;
  const kind = String(adapter || "").toLowerCase();
  if (kind === "cabu") return true;
  return kind === "narratives" && qaOff.reason !== "not_found";
}

/** Own-endpoint adapters do not need the generic generations gateway. */
export function needsAiEndpoint(adapter: unknown, serverRouted = true): boolean {
  return serverRouted && !["cabu", "palettes", "narratives", "agent", "prep_server"].includes(String(adapter || "nlq").toLowerCase());
}

/**
 * Required-field check for starting/resuming a run. The Tableau-gateway path needs a saved server
 * connection (server + PAT); the direct path needs the llm_key/gateway_url
 * credential pair. A redacted (`****…`) PAT counts as absent.
 */
function missingRunFields(config: Record<string, unknown>): string[] {
  // org_id is no longer required: every row used to read
  // "local"; the run's identity is now the server/site snapshot instead.
  const missing: string[] = [];
  if (usesTableauGateway(config)) {
    if (!String(config.tableau_server ?? "").trim()) missing.push("tableau_server");
    const pat = String(config.tableau_pat_value ?? config.pat_value ?? "");
    if (!pat.trim() || pat.startsWith("****")) missing.push("pat_value");
    return missing;
  }
  for (const field of ["llm_key", "gateway_url"]) {
    if (!config[field]) missing.push(field);
  }
  return missing;
}

/**
 * Record, in the run's config, what this run is about to test: which server and site, the model the
 * site had configured at launch, and which build of the tool produced it —
 * otherwise a CSV shared later, or a published row months later, says nothing
 * an admin can act on (bug bash S2-7/S2-8). Read at launch, before the first
 * case runs, so it describes the site as tested even if Site Settings change
 * afterwards. Best effort: a failed lookup leaves the field empty rather than
 * blocking the launch.
 */
async function snapshotRunIdentity(
  ctx: RoutesContext,
  config: Record<string, unknown>,
): Promise<void> {
  config.tool_version = VERSION || "";
  if (!usesTableauGateway(config)) return;
  const tls = {
    verify: (config.verify_tls as boolean | undefined) ?? true,
    caBundlePath: (config.ca_bundle_path as string | undefined) ?? ctx.caBundlePath,
  };
  const fetchImpl = ctx.deps.tableauFetch ?? fetch;
  const server = String(config.tableau_server ?? "").trim().replace(/\/+$/, "");
  config.tableau_server_url = server;
  config.tableau_site_name = String(config.tableau_site ?? "").trim() || "Default";
  try {
    const info = await probeServerinfo(server, "3.22", tls, fetchImpl);
    // Version + build ("2026.1.0 (20261.26.0415.1010)"): a dev server reports
    // 0.0.0 on every build. Runs recorded earlier keep the bare version.
    const version = serverVersionLabel(info);
    if (version) config.tableau_server_version = version;
  } catch {
    // never block a launch on the lookup
  }
  // Queuing must never sign in: a PAT supports one live session. The job
  // completes the identity with its own shared session when it starts.
  const verified = ctx.db.getSetting<Record<string, unknown>>("tableau_preflight") || {};
  if (JSON.stringify(verified.identity) === JSON.stringify(ctx.connectionIdentity(config))) {
    if (verified.model_under_test && !config.resolved_site_model) config.resolved_site_model = verified.model_under_test;
    if (verified.site_id && !config.tableau_site_luid) config.tableau_site_luid = verified.site_id;
  }
  config.identity_pending = true;
}

/**
 * Suite registry. Each suite also says whether the connected Tableau Server
 * can run it: `server_supported` is false, with the reason in
 * `server_message`, for every server-routed suite when the last connection
 * test found a release earlier than 2026.3. The UI disables those
 * suites and shows the reason; the run request refuses them too.
 */
export function getSuites(ctx: RoutesContext, _url: URL): Response {
  const bases = ctx.deps.suiteBases ?? {
    publicBase: publicContent.publicSuitesRoot(),
  };
  const suites = catalog.listSuites(bases);
  const stored = ctx.db.getSetting<Record<string, unknown>>("tableau") || {};
  const tooOld = Object.keys(stored).length ? ctx.serverTooOldFor(stored) : null;
  const qaOff = Object.keys(stored).length ? ctx.dashboardQaOffFor(stored) : null;
  const authoringOff = Object.keys(stored).length ? ctx.webAuthoringOffFor(stored) : null;
  const aiOff = Object.keys(stored).length ? ctx.aiEndpointOffFor(stored) : null;
  for (const suite of suites) {
    const blocked = Boolean(tooOld) && (suite.server_routed ?? true);
    if (!blocked && qaOff && gatedByDashboardsSwitch(suite.adapter, qaOff)) {
      suite.server_supported = false;
      suite.server_message = qaOff.message;
      continue;
    }
    if (!blocked && authoringOff && needsWebAuthoring(suite.adapter)) {
      suite.server_supported = false;
      suite.server_message = authoringOff.message;
      continue;
    }
    if (!blocked && aiOff && needsAiEndpoint(suite.adapter, suite.server_routed ?? true)) {
      suite.server_supported = false;
      suite.server_message = aiOff.message;
      continue;
    }
    suite.server_supported = !blocked;
    suite.server_message = blocked ? tooOld!.message : null;
  }
  return json({ suites, server_too_old: tooOld, dashboard_qa_off: qaOff, web_authoring_off: authoringOff, ai_endpoint_off: aiOff });
}

/** The public pack's fixtures dir, honouring injected suite bases. */
function fixturesDir(ctx: RoutesContext): string | null {
  const base = ctx.deps.suiteBases?.publicBase;
  return base ? join(base, "fixtures") : publicContent.publicFixturesDir();
}

/**
 * The datasets the suites ask about (id, name, field count): the public pack's
 * datasets, then the Prep flows and step data.
 */
export function getDatasets(ctx: RoutesContext): Response {
  return json({
    datasets: [...publicContent.listDatasets(fixturesDir(ctx)), ...listPrepDatasets(ctx.deps.prepRoot), ...listDashboardDatasets()],
  });
}

/**
 * The first rows of a Q&A dataset's extract, read from the `.tdsx` that ships
 * with the tool, so an answer can be checked against the data it was computed
 * from (bug bash 2026-10-23). Only Questions about a dashboard ships rows;
 * every other suite ships its datasets as field lists.
 */
export async function getDatasetRows(ctx: RoutesContext, datasetId: string, url: URL): Promise<Response> {
  void ctx;
  const file = dashboardDatasetFile(datasetId);
  if (!file) {
    return json(
      { error: "The test content on this computer has no rows for this dataset: it ships the dataset's fields only." },
      404,
    );
  }
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
  try {
    const page = await readExtractRows(file, limit);
    return json({ id: datasetId, ...page });
  } catch (err) {
    return json({ error: `The rows could not be read: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

/** One dataset as the model is shown it: fields and sample values. */
export function getDatasetById(ctx: RoutesContext, datasetId: string): Response {
  const dataset =
    publicContent.getDataset(datasetId, fixturesDir(ctx)) ?? getPrepDataset(datasetId, ctx.deps.prepRoot) ?? getDashboardDataset(datasetId);
  if (!dataset) {
    return json(
      { error: "No dataset with this id is part of the test content on this computer." },
      404,
    );
  }
  return json(dataset);
}

/**
 * The dashboards of a Dashboard summaries run, case id -> {name, title}: the
 * dashboard's own name and the descriptive name the results page shows (a
 * case's `info.title`, else the name). Empty when the run's case files are
 * not on this machine.
 */
export function getDashboardTitles(ctx: RoutesContext, jobId: string): Response {
  return json({ dashboards: dashboardCases.titles(ctx.db.getRun(jobId)) });
}

/**
 * The dashboard a Dashboard summaries case is about: its name, its views,
 * whether the case carries a picture of it, and where it is published (so the
 * results page can embed it).
 */
export function getDashboard(ctx: RoutesContext, jobId: string, caseId: string): Response {
  const info = dashboardCases.describe(
    ctx.db.getRun(jobId),
    caseId,
    ctx.db.getSetting<Record<string, unknown>>(dashboardCases.LOCATIONS_SETTING) || {},
  );
  if (info === null) {
    return json({ error: "The test case file for this dashboard is not on this machine." }, 404);
  }
  return json(info);
}

/**
 * Save where this case's dashboard is published, so the results page can
 * embed it: body `{"url": "https://..."}`; an empty url forgets the saved
 * address. Filed under the case's dashboard id, so every run of the same
 * dashboard shares it. Answers with the dashboard as GET now describes it.
 *
 */
export async function putDashboardLocation(
  ctx: RoutesContext,
  jobId: string,
  caseId: string,
  req: Request,
): Promise<Response> {
  const run = ctx.db.getRun(jobId);
  const dashboardId = dashboardCases.dashboardIdOf(run, caseId);
  if (dashboardId === null) {
    return json({ error: "The test case file for this dashboard is not on this machine." }, 404);
  }
  const body = await readJson(req);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (url && !dashboardCases.validLocation(url)) {
    return json(
      { error: "Enter the dashboard's address as a web link, starting with http:// or https://." },
      400,
    );
  }
  const locations = {
    ...(ctx.db.getSetting<Record<string, unknown>>(dashboardCases.LOCATIONS_SETTING) || {}),
  };
  if (url) locations[dashboardId] = url;
  else delete locations[dashboardId];
  ctx.db.setSetting(dashboardCases.LOCATIONS_SETTING, locations);
  return json(dashboardCases.describe(run, caseId, locations));
}

/** The picture of the dashboard, exactly as the case sends it to the server. */
export function getDashboardImage(ctx: RoutesContext, jobId: string, caseId: string): Response {
  const found = dashboardCases.image(ctx.db.getRun(jobId), caseId);
  if (found === null) {
    return json({ error: "This test case has no picture of its dashboard." }, 404);
  }
  return new Response(found.data, {
    headers: { "Content-Type": found.mediaType, "Cache-Control": "private, max-age=3600" },
  });
}

export function getRuns(ctx: RoutesContext, url: URL): Response {
  let limit = 50;
  const raw = url.searchParams.get("limit");
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n)) limit = Math.max(1, Math.min(n, 200));
  }
  const runs = ctx.db.listRuns(limit);
  const known = new Set(runs.map((r) => r.job_id as string));
  for (const [jobId, st] of Object.entries(ctx.db.allJobStates())) {
    if (known.has(jobId)) continue;
    // Legacy queued runs have no runs row until their turn comes. Paused or cancelled
    // while still waiting, it must stay listed (else its batch loses the
    // suite's tab until the worker reaches it); a paused or cancelled run
    // that has a row is merely past the limit.
    const stoppedBeforeStart =
      (st.status === "paused" || st.status === "cancelled") && ctx.db.getRun(jobId) === null;
    if (st.status !== "queued" && !st.never_started && !stoppedBeforeStart) continue;
    runs.unshift({
      job_id: jobId,
      org_id: "",
      ai_feature: st.ai_feature ?? "",
      runner_name: st.runner_name ?? "",
      status: st.status || "queued",
      total: st.total || 0,
      completed: st.completed || 0,
      error: st.error ?? null,
      created_at: st.created_at || "",
      finished_at: null,
      model_name: st.model_name ?? "",
      batch_id: st.batch_id || null,
      suite_id: st.suite_id || null,
      // The catalog's current name wins over the one stored at launch.
      suite_label: catalog.displayLabel(st.suite_id, st.suite_label),
    });
  }
  let pinned = new Set<string>();
  try {
    pinned = new Set(publicContent.pinnedRuns(ctx.settingsStore));
  } catch {
    pinned = new Set();
  }
  for (const r of runs) {
    if (pinned.has(r.job_id as string)) r.pinned = true;
  }
  const scores = ctx.db.runScores(runs.map((r) => r.job_id as string));
  for (const run of runs) {
    // db.listRuns (core) cannot reach the suite catalog (server), so the
    // read-time rename of `list_runs` is applied here: the catalog's current
    // name for the suite id wins over the label stored at launch.
    run.suite_label = catalog.displayLabel(run.suite_id, run.suite_label);
    const sc = scores[run.job_id as string] ?? {
      score: null,
      scored_metrics: 0,
      headline_scores: [],
    };
    Object.assign(run, sc);
    const metadata = ctx.lifecycle.metadata(run.job_id);
    const st = metadata?.state ?? ctx.db.getJobState(run.job_id);
    if (metadata) {
      run.status = metadata.run.status;
      run.total = metadata.run.total;
      run.completed = metadata.run.completed;
      run.revision = metadata.revision;
    }
    if (st && Object.keys(st).length) {
      run.status = st.status || run.status;
      if (st.completed !== undefined && st.completed !== null)
        run.completed = st.completed;
      if (st.total) run.total = st.total;
      for (const k of [
        "judge_provider",
        "judge_model",
        "pause_reason",
        "model_name",
        "never_started",
        "failed_cases",
        "dominant_error",
      ]) {
        if (st[k]) run[k] = st[k];
      }
    }
  }
  return json({ runs, filtered: false });
}

export function getExport(ctx: RoutesContext, jobId: string, url: URL): Response {
  const data = ctx.db.getFullResults(jobId);
  if (data === null) return unknownJob();
  const st = ctx.db.getJobState(jobId);
  const exp = buildExportFromData(
    jobId,
    data,
    st,
  );
  const fmt = (url.searchParams.get("format") || "json").toLowerCase();
  // The file name says what it holds: suite, model, date, run.
  const stem = filenameStem(exp);
  if (fmt === "csv") {
    return new Response(toCsv(exp), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${stem}.csv"`,
      },
    });
  }
  if (fmt !== "json") {
    return json({ error: `The export format must be csv or json, not '${fmt}'.` }, 400);
  }
  return new Response(JSON.stringify(exp, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${stem}.json"`,
    },
  });
}

/**
 * GET /nlq-eval/summary/<job_id> — the run's headline numbers without its
 * cases: what the results page shows for a suite that has paused or finished
 * (cases done, average latency, cases with errors, the quality cards and the
 * category averages). Same arithmetic as the export, so the two agree.
 */
export function getSummary(ctx: RoutesContext, jobId: string): Response {
  const data = ctx.db.getFullResults(jobId);
  if (data === null) return unknownJob();
  const bundle = buildRunBundleFromData(jobId, data, ctx.db.getJobState(jobId));
  const run = bundle.run;
  const summary = bundle.summary;
  return json({
    job_id: jobId,
    status: run.run_status ?? null,
    suite_label: run.suite_label ?? null,
    // Always null since ddce07ed dropped the blended overall from the bundle;
    // Retain the key for API compatibility.
    overall_score: null,
    viz_quality_score: summary.viz_quality_score,
    nl_quality_score: summary.nl_quality_score,
    headline_scores: summary.headline_scores ?? [],
    categories: summary.categories.map((c) => ({
      key: c.key,
      label: c.label,
      weight: c.weight,
      average: c.average,
    })),
    cases_total: summary.cases_total,
    cases_completed: summary.cases_completed,
    cases_scored: summary.cases_scored,
    cases_with_errors: summary.cases_with_errors,
    avg_latency_s: summary.avg_latency_s,
  });
}

export async function postPublish(ctx: RoutesContext, jobId: string, req: Request): Promise<Response> {
  const body = await readJson(req);
  const stored = ctx.db.getSetting<Record<string, unknown>>("tableau") || {};
  if (stored && Object.keys(stored).length) {
    if (!body.tableau_server) body.tableau_server = stored.server_url || "";
    if (!body.tableau_site) body.tableau_site = stored.site || "";
    if (!body.pat_name) body.pat_name = stored.pat_name || "";
    if (!body.pat_value) body.pat_value = stored.pat_value || "";
    if (body.verify_tls === undefined || body.verify_tls === null)
      body.verify_tls = (stored.verify_tls as boolean) ?? true;
  }
  const missing = ["tableau_server", "pat_name", "pat_value"].filter(
    (f) => !body[f],
  );
  if (missing.length) {
    return json(
      {
        error: "Connect to Tableau Server first (Evaluation Setup, step 1).",
      },
      400,
    );
  }
  const data = ctx.db.getFullResults(jobId);
  if (data === null) return unknownJob();
  const st = ctx.db.getJobState(jobId);
  const exp = buildExportFromData(
    jobId,
    data,
    st,
  );
  try {
    const session = ctx.makeSession(body);
    const result = await publishRun(exp, {
      session,
      projectName: (body.project_name as string) || DEFAULT_PROJECT,
      datasourceName: (body.datasource_name as string) || DEFAULT_DATASOURCE,
      verify: (body.verify_tls as boolean) ?? true,
      // Trust the private/enterprise CA on the publisher's REST calls too —
      // not just on session sign-in. Without this, sign-in succeeds but every
      // publish REST call fails TLS against a self-signed/private CA.
      caBundlePath: ctx.caBundlePath,
      fetchImpl: ctx.deps.tableauFetch,
    });
    return json(result);
  } catch (exc) {
    if (exc instanceof TableauAuthError) return json({ error: exc.message }, 401);
    if (exc instanceof SchemaMismatch)
      return json({ error: exc.message, reason: "schema_mismatch" }, 409);
    if (exc instanceof HttpError)
      return json(
        {
          error:
            `Tableau Server returned an error while publishing (${exc.message}). Try again, ` +
            "or test the connection in Evaluation Setup, step 1.",
        },
        502,
      );
    const msg = exc instanceof Error ? exc.message : String(exc);
    return json({ error: `The results couldn't be published (${msg}). Try again.` }, 502);
  }
}

export async function postRun(ctx: RoutesContext, req: Request): Promise<Response> {
  let config = await readJson(req);
  if (!config || Object.keys(config).length === 0)
    return json(
      {
        error:
          "The run request has no body. Send the suite to run as a JSON object " +
          '(GETTING_STARTED.md, "Using the API instead of the browser").',
      },
      400,
    );
  config = ctx.mergeTableauSettings(config);
  const catalogAdapter = catalog.adapterFor(String(config.suite_id || ""));
  if (catalogAdapter) config.adapter = catalogAdapter;
  // A suite named by id alone (an API caller) runs from the file the catalog
  // lists for it; the page sends that path itself. A combined suite loads its
  // parts and needs no path.
  const suiteId = String(config.suite_id || "");
  if (suiteId && !config.test_path && !config.test_cases_dir && !catalog.partsOf(suiteId, publicContent.publicSuitesRoot()).length) {
    const suitePath = catalog.suitePathFor(suiteId, ctx.deps.suiteBases ?? {
      publicBase: publicContent.publicSuitesRoot(),
    });
    if (suitePath) config.test_path = suitePath;
  }
  const aiOff = ctx.aiEndpointOffFor(config);
  if (aiOff && usesTableauGateway(config) && needsAiEndpoint(config.adapter)) {
    return json({ error: aiOff.message, reason: "ai_endpoint_unavailable" }, 400);
  }
  // Thread the edge-resolved CA bundle into the run config so the harness
  // runner's per-run TableauSession trusts a private/enterprise CA (verify
  // stays on) — mirrors postPreflight. Without this, a self-signed/private-CA
  // server fails signin during the run even though preflight passed.
  if (ctx.caBundlePath && !(config as Record<string, unknown>).ca_bundle_path) {
    (config as Record<string, unknown>).ca_bundle_path = ctx.caBundlePath;
  }

  const missing = missingRunFields(config);
  if (missing.length) {
    if (usesTableauGateway(config)) {
      return json(
        { error: "Connect to Tableau Server first (Evaluation Setup, step 1)." },
        400,
      );
    }
    return json(
      {
        error:
          `This run is missing ${missing.join(", ")}. A direct-gateway run (developer ` +
          "mode) must name the gateway address and key; a customer run routes through " +
          "the saved Tableau Server connection and needs neither.",
      },
      400,
    );
  }

  // A release earlier than 2026.3 has no AI endpoint: every server-routed
  // suite would fail on its first case. The connection test recorded the
  // verdict; refuse here with the same explanation the UI shows.
  if (usesTableauGateway(config)) {
    const tooOld = ctx.serverTooOldFor(config);
    if (tooOld) return json({ error: tooOld.message, reason: "server_too_old" }, 400);
  }

  // Tableau Agent in Dashboards off on the site: Questions about a dashboard
  // and Dashboard Narratives both stop here, with the explanation the UI shows.
  const qaOff = ctx.dashboardQaOffFor(config);
  if (qaOff && gatedByDashboardsSwitch(config.adapter, qaOff)) {
    return json({ error: qaOff.message, reason: "dashboard_qa_disabled" }, 400);
  }

  if (String(config.adapter || "").toLowerCase() === "cabu") {
    const needs = mergeDashboardContent(ctx, config);
    if (needs) return json({ error: needs, reason: "dashboard_content_missing" }, 400);
  }

  // Tableau Agent in Authoring off on the site: every case of these suites
  // would get the server's 403. Refuse with the explanation the UI shows.
  if (needsWebAuthoring(config.adapter)) {
    const authoringOff = ctx.webAuthoringOffFor(config);
    if (authoringOff) return json({ error: authoringOff.message, reason: "web_authoring_disabled" }, 400);
  }

  if (usesTableauGateway(config)) {
    // Placeholder until the CES bridge re-points runners at 127.0.0.1. Cabu
    // never reads these. Do NOT invent a gateway_url — that would be written
    // into the run config before the bridge starts. Callers pass credentials
    // explicitly; no credential files are discovered implicitly.
    if (!config.llm_key) config.llm_key = "local-ces-bridge";
  } else {
    // Direct-gateway path: reject a schemeless gateway_url at the boundary so
    // the runner doesn't fail per-case with an invalid URL.
    const gw = String(config.gateway_url || "");
    if (!gw.startsWith("http://") && !gw.startsWith("https://")) {
      return json(
        {
          error:
            `The gateway URL '${gw}' is not valid: it must start with http:// or ` +
            "https://. Fix the gateway URL field.",
        },
        400,
      );
    }
  }

  if (config.compute_nl_judge && !ctx.db.getSetting("judge")) {
    return json(
      {
        error:
          "This suite needs an evaluator model for its scores. Set up an evaluator " +
          "model in Evaluation Setup, step 2, then evaluate again.",
      },
      409,
    );
  }
  await snapshotRunIdentity(ctx, config);

  // A judge from the model under test's own family is a warning on the run,
  // never a block (UX review 2026-09-24). The model under test is
  // the one the admin declared for the record, else the one read from Site
  // Settings at launch; the warning is stored in the run's config so the
  // results page keeps showing it, and returned so the launcher can say so
  // straight away.
  const warnings: string[] = [];
  if (config.compute_nl_judge) {
    const judgeCfg = ctx.db.getSetting<Record<string, unknown>>("judge") || {};
    const underTest =
      String(config.declared_site_model || "").trim() ||
      String(config.resolved_site_model || "").trim();
    const family = underTest ? detectFamily(underTest) : null;
    if (family && family === judgeCfg.provider) {
      const msg =
        `The evaluated model (${underTest}) and the evaluator model ` +
        `(${judgeCfg.model || judgeCfg.provider}) are both ` +
        `${family} models. A model evaluating its own family tends to favor ` +
        "it, so read this run's evaluator scores with that in mind, and " +
        "configure an evaluator model from another provider for the next run.";
      config.judge_family_warning = msg;
      warnings.push(msg);
    }
  }

  // A run launched with a suite id but no label (API callers) still gets the
  // catalog's name, so nothing downstream shows the internal runner id
  // ("What is this ECT server?").
  if (config.suite_id && !config.suite_label) {
    const label = catalog.suiteLabelFor(String(config.suite_id));
    if (label) config.suite_label = label;
  }

  const jobId = ctx.genJobId();
  // Persist the launch before handing it to the serial worker. Queued runs
  // must be resumable (including after restart), not just synthetic UI rows.
  ctx.db.createRun({
    job_id: jobId,
    org_id: String(config.org_id || ""),
    user_id: String(config.user || ""),
    ai_feature: String(config.ai_feature || ""),
    runner_name: String(config.runner || ""),
    config,
  });
  ctx.lifecycle.patch(jobId, { status: "queued", total: 0, completed: 0 });
  let total = 0;
  // load() reads local suite data; do not call session(), sign in, publish,
  // or execute while another job owns the queue. Reload in the worker after
  // target resolution, rather than caching a live adapter/opaque runner.
  try {
    const adapter = await (ctx.orchestratorDeps.getAdapter ?? getAdapter)(config);
    const plan = await adapter.load({ ...config });
    total = plan.total;
    ctx.lifecycle.commit(jobId, { run: { total }, cases: plan.skeletons });
    if (plan.skeletons?.length) ctx.sse.appendEvent(jobId, { type: "skeletons", items: plan.skeletons });
  } catch (error) {
    // Some adapters need targets resolved at execution time. Preview failure
    // must not turn a valid launch into an error; the worker reports failures.
    ctx.orchestratorDeps.log?.(`Job ${jobId}: queued suite preview unavailable`, error);
  }
  const models = (config.models as Record<string, unknown>) || {};
  ctx.writeState(jobId, {
    status: "queued",
    completed: 0,
    total,
    // Launch time in the runs-row format (UTC, to the second), so a job still
    // waiting its turn sorts with the evaluation it belongs to instead of
    // falling to the bottom of every list for lack of a date.
    created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    user_id: config.user || "",
    ai_feature: config.ai_feature || "",
    batch_id: config.batch_id || "",
    suite_id: config.suite_id || "",
    suite_label: config.suite_label || "",
    runner_name: config.runner || "",
    // The token NAME (never the secret) so a connection test can tell it would
    // end this run's session (a PAT supports one live session).
    pat_name: config.tableau_pat_name || config.pat_name || "",
    model_name:
      models.create || models.understand || config.resolved_site_model || config.declared_site_model || "",
    model_provider: config.model_provider || "",
  });
  ctx.jobConfigs.set(jobId, config);
  ctx.queue.submit(() => ctx.jobConfigs.get(jobId) === config && ctx.readState(jobId).status === "queued"
    ? runNlqEvalJob(ctx.orchestratorDeps, config, jobId) : undefined);
  return json(
    {
      job_id: jobId,
      results_url: `/results/${jobId}`,
      ...(warnings.length ? { warnings } : {}),
    },
    202,
  );
}

export function getStatus(ctx: RoutesContext, jobId: string): Response {
  let st = ctx.lifecycle.metadata(jobId)?.state ?? ctx.readState(jobId);
  if (!st || Object.keys(st).length === 0) {
    const run = ctx.db.getRun(jobId);
    if (!run) return unknownJob();
    st = {
      status: run.status,
      completed: run.completed,
      total: run.total,
    };
  }
  const status = (st.status as string) || "queued";
  let code = 202;
  if (status === "finished") code = 200;
  else if (status === "failed") code = 500;
  return json(st, code);
}

/** Scheduling policy belongs on the server: stop every batch member before
 * aborting the current worker, so it cannot start an untouched queued suite. */
export function postBatchPause(ctx: RoutesContext, batchId: string): Response {
  const targets = ctx.db.listRuns(100000).filter(run => run.batch_id === batchId &&
    ["queued", "started", "running"].includes(String(ctx.readState(run.job_id).status ?? run.status)));
  if (!targets.length) return json({ error: "No active suite in this evaluation can be paused." }, 409);
  ctx.db.db.transaction(() => {
    for (const run of targets) ctx.lifecycle.stop(run.job_id, "paused", false);
  })();
  ctx.sse.notifier.notifyAll();
  for (const run of targets) {
    ctx.orchestratorDeps.runControllers?.get(run.job_id)?.abort();
    ctx.sse.appendEvent(run.job_id, { type: "done", status: "paused" });
  }
  return json({ ok: true, paused: targets.length });
}

/** Cancel every unfinished batch member (queued, running or paused) in one
 * transaction before aborting the worker, so cancelling the current suite
 * cannot hand the worker to a sibling that has not been cancelled yet. */
export function postBatchCancel(ctx: RoutesContext, batchId: string): Response {
  const targets = ctx.db.listRuns(100000).filter(run => run.batch_id === batchId &&
    ["queued", "started", "running", "paused"].includes(String(ctx.readState(run.job_id).status ?? run.status)));
  if (!targets.length) return json({ error: "No unfinished suite in this evaluation can be canceled." }, 409);
  const cancelled = ctx.db.db.transaction(() =>
    targets.filter(run => ctx.lifecycle.stop(run.job_id, "cancelled", false)))();
  if (!cancelled.length) return json({ error: "This evaluation has already ended." }, 409);
  ctx.sse.notifier.notifyAll();
  for (const run of cancelled) {
    ctx.orchestratorDeps.runControllers?.get(run.job_id)?.abort();
    ctx.sse.appendEvent(run.job_id, { type: "done", status: "cancelled" });
  }
  return json({ ok: true, cancelled: cancelled.length });
}

export function getResults(ctx: RoutesContext, jobId: string): Response {
  let data = ctx.db.getFullResults(jobId) as Record<string, unknown> | null;
  if (data === null) {
    const st = ctx.readState(jobId);
    if (!st || Object.keys(st).length === 0)
      return unknownJob();
    const cfg: Record<string, unknown> = {};
    for (const k of ["suite_id", "suite_label", "batch_id"])
      if (st[k]) cfg[k] = st[k];
    data = {
      run: {
        job_id: jobId,
        org_id: "",
        user_id: st.user_id ?? "",
        ai_feature: st.ai_feature ?? "",
        runner_name: st.runner_name ?? "",
        config: cfg,
        status: st.status || "queued",
        total: st.total || 0,
        completed: st.completed || 0,
        error: st.error ?? null,
        created_at: st.created_at || "",
        finished_at: null,
      },
      results: [],
      metrics: [],
      errors: [],
    };
  }
  data.state = ctx.readState(jobId);
  const metadata = ctx.lifecycle.metadata(jobId);
  if (metadata) {
    data.run = metadata.run;
    data.state = metadata.state;
  }
  return json(data);
}

export function getResultsClassic(ctx: RoutesContext, jobId: string): Response {
  const st = ctx.readState(jobId);
  if (!st || Object.keys(st).length === 0) {
    if (!ctx.db.getRun(jobId))
      return new Response("<h2>Job not found</h2>", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
  }
  return new Response(
    `<!doctype html><html><head><title>Tableau AI Model Evaluation Tool results ${jobId}</title></head>` +
      `<body><h2>Tableau AI Model Evaluation Tool results</h2><p>Job ${jobId}. ` +
      `Fetch <code>/nlq-eval/results/${jobId}</code> for JSON.</p></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}

export function postCancel(ctx: RoutesContext, jobId: string): Response {
  if (
    Object.keys(ctx.readState(jobId)).length === 0 &&
    !ctx.db.getRun(jobId)
  ) {
    return unknownJob();
  }
  if (!ctx.lifecycle.stop(jobId, "cancelled")) return json({ error: "This run has already ended." }, 409);
  ctx.orchestratorDeps.runControllers?.get(jobId)?.abort();
  ctx.sse.appendEvent(jobId, { type: "done", status: "cancelled" });
  return json({ ok: true });
}

export function postPause(ctx: RoutesContext, jobId: string): Response {
  const st = ctx.readState(jobId);
  if (Object.keys(st).length === 0 && !ctx.db.getRun(jobId))
    return unknownJob();
  const status =
    (st.status as string) || ((ctx.db.getRun(jobId) || {}).status as string);
  if (!["queued", "started", "running"].includes(status)) {
    return json(
      {
        error:
          `This evaluation is ${status || "in an unknown state"}, so there is nothing ` +
          "to pause. Only an evaluation that is queued or in progress can be paused.",
      },
      409,
    );
  }
  if (!ctx.lifecycle.stop(jobId, "paused")) return json({ error: "This run is no longer active." }, 409);
  // Release the serial queue promptly, rather than waiting for in-flight
  // requests/rate limits/judges to finish while the UI already says paused.
  // Interrupted cases are not persisted and will run again on resume.
  ctx.orchestratorDeps.runControllers?.get(jobId)?.abort();
  ctx.sse.appendEvent(jobId, { type: "done", status: "paused" });
  return json({ ok: true, status: "paused" });
}

export async function postResume(ctx: RoutesContext, jobId: string, req: Request): Promise<Response> {
  return resumeRun(ctx, jobId, await readJson(req));
}

/** Resume every paused (or stopped-with-unasked-cases) suite of a batch, in
 * launch order, so one click on the evaluation's row continues the whole
 * Evaluate all. A suite that cannot be resumed (its evaluator model changed,
 * the connection is gone) does not stop the others: the response carries the
 * count resumed and the first refusal's wording. */
export async function postBatchResume(ctx: RoutesContext, batchId: string, req: Request): Promise<Response> {
  const overrides = await readJson(req);
  const targets = ctx.db.listRuns(100000)
    .filter(run => run.batch_id === batchId && isResumable(ctx, run.job_id, run))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!targets.length) return json({ error: "No paused suite in this evaluation can be resumed." }, 409);
  let resumed = 0;
  let refusal: Record<string, unknown> | null = null;
  for (const run of targets) {
    const res = await resumeRun(ctx, run.job_id, { ...overrides });
    if (res.status === 202) resumed += 1;
    else if (!refusal) refusal = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }
  if (!resumed) return json(refusal || { error: "No suite could be resumed." }, 409);
  return json({ ok: true, resumed, skipped: targets.length - resumed, ...(refusal ? { error: refusal.error } : {}) }, 202);
}

/** The resume rule, shared by the single-run and batch routes: paused, or
 * stopped/finished with cases still unasked or failed. */
function isResumable(ctx: RoutesContext, jobId: string, run: { status?: unknown; total?: unknown; completed?: unknown }): boolean {
  const st = ctx.readState(jobId);
  const status = String(st.status ?? run.status ?? "");
  const unasked = Number(st.total || run.total || 0) - Number(st.completed || run.completed || 0);
  const failedCases = Number(st.failed_cases || 0);
  return status === "paused" || (status === "failed" && unasked > 0) || (status === "finished" && failedCases > 0);
}

async function resumeRun(ctx: RoutesContext, jobId: string, overrides: Record<string, unknown>): Promise<Response> {
  // Compatibility for a queued job launched before run-at-launch persistence.
  if (!ctx.db.getRun(jobId) && ctx.jobConfigs.has(jobId)) {
    const config = ctx.jobConfigs.get(jobId)!;
    ctx.db.createRun({ job_id: jobId, org_id: String(config.org_id || ""), user_id: String(config.user || ""),
      ai_feature: String(config.ai_feature || ""), runner_name: String(config.runner || ""), config });
  }
  const run = ctx.db.getRun(jobId);
  if (run === null) return unknownJob();
  const st = ctx.readState(jobId);
  const status = (st.status as string) || (run.status as string);
  if (!isResumable(ctx, jobId, run))
    return json(
      {
        error:
          `This evaluation is ${status}, so it can't be resumed. Only a paused ` +
          "evaluation, or one that stopped or finished with failed questions, can be; to run it again, evaluate it from the home page.",
      },
      409,
    );

  let config = ctx.jobConfigs.get(jobId);
  if (config === undefined) {
    const stored =
      run.config && typeof run.config === "object"
        ? (run.config as Record<string, unknown>)
        : {};
    // Rehydrate: drop masked values (secrets redacted at rest).
    config = {};
    for (const [k, v] of Object.entries(stored)) {
      if (isRedacted(v)) continue;
      config[k] = v;
    }
  }
  // Validation yielded: another command may have changed the run in the meantime.
  config = ctx.mergeTableauSettings({ ...config, ...overrides });
  if (usesTableauGateway(config) && !config.llm_key) {
    config.llm_key = "local-ces-bridge";
  }

  const missing = missingRunFields(config);
  if (missing.length) {
    if (usesTableauGateway(config)) {
      return json(
        {
          error:
            "Can't resume: the Tableau Server connection is missing. Connect " +
            "again in Evaluation Setup, step 1, then resume.",
        },
        409,
      );
    }
    return json(
      {
        error: `Cannot resume: missing ${missing.join(", ")}. Secrets are redacted at rest, so after a restart they must be re-supplied in the resume request body or via the fallback credential file.`,
      },
      409,
    );
  }
  if (config.compute_nl_judge && !ctx.db.getSetting("judge")) {
    return json(
      {
        error:
          "Can't resume: this run uses evaluator scores and the evaluator model was removed. " +
          "Set up an evaluator model in Evaluation Setup, step 2, then resume.",
      },
      409,
    );
  }
  if (config.compute_nl_judge) {
    // A run keeps the evaluator model it started with: scores from two
    // evaluator models in one run could not be told apart (bug bash
    // 2026-10-23, item 22). The orchestrator stamps the model at START.
    const started = (ctx.db.getJobState(jobId) || {}) as Record<string, unknown>;
    const judge = ctx.db.getSetting<Record<string, unknown>>("judge") || {};
    const startedWith = String(started.judge_provider || "");
    if (
      startedWith &&
      (judge.provider !== startedWith || String(judge.model || "") !== String(started.judge_model || ""))
    ) {
      return json(
        {
          error:
            `Can't resume: this run started with the evaluator model ${startedWith} ${started.judge_model || ""}`.trim() +
            `, and the evaluator model is now ${judge.provider} ${judge.model || ""}`.trim() +
            ". Set the evaluator model back to resume, or start a new evaluation with the new one.",
          reason: "judge_changed",
        },
        409,
      );
    }
  }
  if (usesTableauGateway(config)) {
    const tooOld = ctx.serverTooOldFor(config);
    if (tooOld) return json({ error: tooOld.message, reason: "server_too_old" }, 409);
  }

  config._resumed = true;
  if (!ctx.lifecycle.resume(jobId)) return json({ error: "The run changed while resume was being prepared. Refresh and try again." }, 409);
  ctx.jobConfigs.set(jobId, config);
  // The pause (or the boot-time auto-pause) logged a durable `done` so
  // streaming clients would stop; every later connection replayed it and
  // closed before the live events, leaving the page without Pause/Cancel for
  // the rest of the run. Drop it before
  // re-queuing.
  ctx.db.deleteEvents(jobId, ["done", "error"]);
  const cfg = config;
  ctx.queue.submit(() => ctx.jobConfigs.get(jobId) === cfg && ctx.readState(jobId).status === "queued"
    ? runNlqEvalJob(ctx.orchestratorDeps, cfg, jobId) : undefined);
  return json({ job_id: jobId, results_url: `/results/${jobId}`, resumed: true }, 202);
}

export function deleteResults(ctx: RoutesContext, jobId: string): Response {
  const st = ctx.readState(jobId);
  const run = ctx.db.getRun(jobId);
  // Unknown job → 404 (mirror db.deleteRun's "unknown job" behavior).
  if (Object.keys(st).length === 0 && !run) {
    return unknownJob();
  }
  // Refuse to delete an in-flight run: it could orphan rows or race the
  // queued closure (which may re-createRun / re-insert results after delete).
  const status = (st.status as string) || ((run || {}).status as string);
  if (["queued", "started", "running"].includes(status)) {
    return json(
      {
        error: `job is ${status}; cancel it first (POST /nlq-eval/cancel/${jobId}) before deleting`,
      },
      409,
    );
  }
  ctx.jobConfigs.delete(jobId);
  if (!ctx.db.deleteRun(jobId)) return unknownJob();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

export function streamEvents(ctx: RoutesContext, jobId: string, req: Request): Response {
  let st = ctx.readState(jobId);
  if (!st || Object.keys(st).length === 0) {
    const run = ctx.db.getRun(jobId);
    if (!run) return unknownJob();
    st = {
      status: run.status || "queued",
      total: run.total || 0,
      completed: run.completed || 0,
    };
  }

  const encoder = new TextEncoder();
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(ctrl) {
      const emit = (obj: Record<string, unknown>) =>
        ctrl.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const snapshot = ctx.sse.getEvents(jobId);
        let lastId = snapshot.length ? snapshot[snapshot.length - 1].id : 0;

        const total = (st.total as number) || 0;
        if (total) emit({ type: "start", total });
        for (const ev of snapshot)
          if (ev.type === "skeletons") ctrl.enqueue(encoder.encode(ev.payload + "\n"));
        for (const ev of snapshot)
          if (ev.type === "row") ctrl.enqueue(encoder.encode(ev.payload + "\n"));
        const completed = (st.completed as number) || 0;
        if (completed) emit({ type: "progress", completed, total });

        const status = (st.status as string) || "queued";
        if (["finished", "failed", "cancelled", "paused"].includes(status)) {
          emit({ type: "done", status });
          ctrl.close();
          return;
        }
        // The cases in flight right now, so a page opened mid-run shows them
        // as running at once instead of at the next case start.
        const running = (st.running_case_ids as string[] | undefined) ?? [];
        if (running.length) emit({ type: "running", ids: running });
        let lastStart = 0;
        for (const ev of snapshot) if (ev.type === "start" && ev.id > lastStart) lastStart = ev.id;
        for (const ev of snapshot) {
          if (ev.type === "done") {
            // The run is active (checked just above), so a logged `paused`
            // done-line is left over from a pause that has since been resumed:
            // forwarding it would close this stream before the live events and
            // hide the controls. A
            // finished/failed/cancelled line still closes the stream — there
            // the state blob is what lags.
            if (doneStatus(ev.payload) === "paused") continue;
            // Likewise any "done" the run has started again after: it closed
            // an earlier pass, not the one running now (a tab showed Complete
            // over a suite at 165 of 166).
            if (ev.id < lastStart) continue;
            ctrl.enqueue(encoder.encode(ev.payload + "\n"));
            ctrl.close();
            return;
          }
        }

        // Live tail
        let lastSend = Date.now();
        while (!controller.signal.aborted) {
          const newEvents = ctx.sse.getEvents(jobId, lastId);
          if (newEvents.length) {
            let done = false;
            for (const ev of newEvents) {
              ctrl.enqueue(encoder.encode(ev.payload + "\n"));
              lastId = ev.id;
              if (ev.type === "done") done = true;
            }
            if (done) {
              ctrl.close();
              return;
            }
            lastSend = Date.now();
          } else {
            const now = Date.now();
            if (now - lastSend >= HEARTBEAT_SECS * 1000) {
              ctrl.enqueue(encoder.encode("{}\n"));
              lastSend = now;
            }
            await ctx.sse.notifier.wait(LIVE_POLL_SECS * 1000);
          }
        }
        ctrl.close();
      } catch {
        try {
          ctrl.close();
        } catch {}
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Accel-Buffering": "no",
      // Announcing keep-alive on legacy servers made the browser hand this
      // connection to its next request once the stream had ended, which then
      // hung until it timed out (a 20 s stall). Bun serves
      // keep-alive fine, but `close` is kept for wire parity.
      Connection: "close",
    },
  });
}
