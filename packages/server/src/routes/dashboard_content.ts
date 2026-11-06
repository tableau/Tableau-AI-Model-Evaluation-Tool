/**
 * Dashboard Q&A's published-content ids, remembered per server and site, and
 * the routes that publish the sample content the suites ask about.
 *
 * A Questions about a dashboard suite asks about one workbook published on the
 * admin's own site, named by its workbook and datasource LUIDs. A suite with
 * sample content in the tool gets the ids the tool published for it
 * (`suites/dashboard_content.ts`); any other suite takes the ids
 * from the run request once, and later runs (Evaluate all, the results page)
 * reuse them for the same connection. /
 * `_merge_dashboard_content` and the `/nlq-eval/dashboard-content` routes in
 * the dashboard content API.
 */

import { TableauAuthError } from "@tableau-ai-eval/core";
import * as content from "../suites/dashboard_content.ts";
import { partsOf } from "../suites/catalog.ts";
import { publicSuitesRoot } from "../suites/public_content.ts";
import { json, type RoutesContext } from "./context.ts";

const DASHBOARD_CONTENT_KEYS = ["workbook_luid", "datasource_luid", "datasource_name"] as const;

function dashboardConnectionKey(server: string, site: string): { server_url: string; site: string } {
  return {
    server_url: (server || "").trim().replace(/\/+$/, "").toLowerCase(),
    site: (site || "").trim(),
  };
}

/**
 * The workbook and datasource ids last used for dashboard Q&A on this server
 * and site, or {}. Ids belong to one site, so ids saved for another connection
 * are never offered.
 */
export function storedDashboardContent(
  ctx: RoutesContext,
  server: string,
  site: string,
): Record<string, string> {
  const stored = ctx.db.getSetting<Record<string, unknown>>("dashboard_qa") || {};
  const here = dashboardConnectionKey(server, site);
  for (const [k, v] of Object.entries(here)) {
    if (stored[k] !== v) return {};
  }
  const out: Record<string, string> = {};
  for (const k of DASHBOARD_CONTENT_KEYS) {
    if (stored[k]) out[k] = String(stored[k]);
  }
  return out;
}

/**
 * Dashboard Q&A asks about one published workbook, named by its ids.
 *
 * A suite with sample content in the tool gets the ids the tool published for
 * it on this site (`dashboard_content`). Otherwise a run that gives ids is
 * remembered; a run that omits them (Evaluate all, the results page) reuses
 * the remembered ones. Returns the message for the caller when there are none
 * to use.
 */
export function mergeDashboardContent(ctx: RoutesContext, config: Record<string, unknown>): string | null {
  const given = (key: string): string => {
    const value = String(config[key] ?? "").trim();
    return value === "PLACEHOLDER" ? "" : value;
  };
  const server = String(config.tableau_server || "");
  const site = String(config.tableau_site || "");
  const suiteId = String(config.suite_id || "");
  const parts = partsOf(suiteId, ctx.deps.suiteBases?.publicBase ?? publicSuitesRoot());
  if (parts.length) {
    config._suite_parts = parts;
    config._content_from_tool = true;
    return null;
  }
  if (suiteId && !(given("workbook_luid") && (given("datasource_luid") || config.datasource_luids))) {
    const published = content.runIdsFor(ctx.settingsStore, suiteId, server, site);
    if (Object.keys(published).length) {
      for (const [key, value] of Object.entries(published)) {
        if (value && !config[key]) config[key] = value;
      }
      config._content_from_tool = true;
      return null;
    }
    if (content.suiteContent(suiteId, contentEnv(ctx)) !== null) {
      config._content_from_tool = true;
      return null;
    }
  }
  if (given("workbook_luid") && given("datasource_luid")) {
    const record: Record<string, string> = { ...dashboardConnectionKey(server, site) };
    for (const k of DASHBOARD_CONTENT_KEYS) if (given(k)) record[k] = given(k);
    ctx.db.setSetting("dashboard_qa", record);
    return null;
  }
  const stored = storedDashboardContent(ctx, server, site);
  if (stored.workbook_luid && stored.datasource_luid) {
    for (const [key, value] of Object.entries(stored)) {
      if (!given(key)) config[key] = value;
    }
    return null;
  }
  return (
    "Questions about a dashboard needs the ids of the workbook and data " +
    "source published on your site. Open the suite's set-up, publish the " +
    "sample content or enter the ids once; later runs reuse them."
  );
}

// ---------------------------------------------------------------------------
// Sample content for Questions about a dashboard
// ---------------------------------------------------------------------------

/** The manifest follows injected suite bases, like the catalog does. */
function contentEnv(ctx: RoutesContext): content.ContentEnv {
  const base = ctx.deps.suiteBases?.publicBase;
  return base !== undefined ? { publicBase: base } : {};
}

function storedConnection(ctx: RoutesContext): Record<string, unknown> {
  return ctx.db.getSetting<Record<string, unknown>>("tableau") || {};
}

/**
 * For every suite with sample content: what the tool would publish and
 * whether it already did so on the connected site.
 */
export function getDashboardContent(ctx: RoutesContext): Response {
  const conn = storedConnection(ctx);
  const server = String(conn.server_url || "");
  const site = String(conn.site || "");
  return json({
    configured: Object.keys(conn).length > 0,
    server_url: server,
    site,
    suites: content.contentStatus(ctx.settingsStore, server, site, contentEnv(ctx)),
  });
}

/**
 * Publish the suite's data sources and a generated workbook to the connected
 * site with the stored connection, and remember the ids.
 */
export async function postDashboardContentPublish(ctx: RoutesContext, suiteId: string): Promise<Response> {
  const conn = storedConnection(ctx);
  if (!(conn.server_url && conn.pat_name && conn.pat_value)) {
    return json({ error: "Connect to Tableau Server first (Evaluation Setup, step 1)." }, 400);
  }
  const parts = partsOf(suiteId, ctx.deps.suiteBases?.publicBase ?? publicSuitesRoot());
  if (content.suiteContent(suiteId, contentEnv(ctx)) === null && !parts.length) {
    return json(
      { error: `No sample content is defined for the suite '${suiteId}'.`, reason: "unknown_suite" },
      404,
    );
  }
  let ids: content.PublishedContent;
  try {
    const active = Object.entries(ctx.db.allJobStates()).find(([, state]) =>
      ["started", "running"].includes(String(state.status)) && state.pat_name === conn.pat_name,
    );
    if (active) return json({ error: "An evaluation is running with this token. Wait for it to finish or pause it first; an evaluation publishes the sample content it needs by itself.", reason: "run_in_progress", job_id: active[0] }, 409);
    const session = ctx.makeSession({
      tableau_server: String(conn.server_url).replace(/\/+$/, ""),
      tableau_site: conn.site || "",
      pat_name: conn.pat_name,
      pat_value: conn.pat_value,
      verify_tls: conn.verify_tls ?? true,
    });
    if (parts.length) {
      // Keyed by content id: two parts about one dashboard (its data
      // questions and its declines) publish it once.
      const published: Record<string, content.PublishedContent> = {};
      for (const part of parts) {
        const contentId = part.content ?? part.id;
        if (published[contentId]) continue;
        published[contentId] = await (ctx.deps.publishSuiteContent ?? content.publishSuiteContent)(contentId, conn, {
          session, store: ctx.settingsStore, verify: conn.verify_tls !== false,
          caBundlePath: ctx.caBundlePath, fetchImpl: ctx.deps.tableauFetch, ...contentEnv(ctx),
        });
      }
      return json({ suite_id: suiteId, parts: published });
    }
    ids = await (ctx.deps.publishSuiteContent ?? content.publishSuiteContent)(suiteId, conn, {
      session,
      store: ctx.settingsStore,
      verify: (conn.verify_tls as boolean) ?? true,
      caBundlePath: ctx.caBundlePath,
      fetchImpl: ctx.deps.tableauFetch,
      ...contentEnv(ctx),
    });
  } catch (exc) {
    if (exc instanceof TableauAuthError) return json({ error: exc.message }, 401);
    if (exc instanceof content.ContentPublishError) {
      return json({ error: exc.message, reason: "publish_failed" }, 502);
    }
    const msg = exc instanceof Error ? exc.message : String(exc);
    if (exc instanceof TypeError || (exc as { name?: string })?.name === "TimeoutError") {
      return json(
        {
          error:
            `Tableau Server could not be reached while publishing (${msg}). Try again, ` +
            "or test the connection in Evaluation Setup, step 1.",
          reason: "unreachable",
        },
        502,
      );
    }
    ctx.deps.log?.(`Publishing sample content for ${suiteId} failed`, exc);
    return json({ error: `The sample content couldn't be published (${msg}). Try again.` }, 502);
  }
  return json({ suite_id: suiteId, ids });
}

/**
 * Forget the ids remembered for the suite on the connected site (the content
 * itself stays on the server).
 */
export function deleteDashboardContent(ctx: RoutesContext, suiteId: string): Response {
  const conn = storedConnection(ctx);
  content.forgetContent(ctx.settingsStore, String(conn.server_url || ""), String(conn.site || ""), suiteId);
  return json({ suite_id: suiteId, forgotten: true });
}
