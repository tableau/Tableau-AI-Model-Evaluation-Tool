/**
 * NLQ Evaluator HTTP routes, delegating to dedicated handler modules.
 *
 * The routes are mounted
 * on a plain `fetch(req) => Response` handler so an app factory can return the
 * handler for in-process testing (no port binding required) and `Bun.serve`
 * can mount it for real.
 *
 * Delegation map (faithful to the Python handlers):
 *   GET  /nlq-eval/suites              -> suites/catalog.listSuites
 *   GET  /nlq-eval/datasets[/<id>]     -> suites/public_content.listDatasets/getDataset
 *   GET  /nlq-eval/dashboards/<job_id>  -> suites/dashboard_cases.titles
 *   GET  /nlq-eval/dashboards/<job_id>/<case_id>[/image] -> suites/dashboard_cases
 *   PUT  /nlq-eval/dashboards/<job_id>/<case_id>/location -> settings dashboard_locations
 *   GET  /nlq-eval/dashboard-content   -> suites/dashboard_content.contentStatus
 *   POST /nlq-eval/dashboard-content/<suite>/publish -> suites/dashboard_content.publishSuiteContent
 *   DELETE /nlq-eval/dashboard-content/<suite> -> suites/dashboard_content.forgetContent
 *   GET  /nlq-eval/runs                -> db.listRuns + state overlay
 *   GET  /nlq-eval/export/<job_id>     -> publish/export.buildExportFromData/toCsv
 *   GET  /nlq-eval/summary/<job_id>    -> publish/records.buildRunBundleFromData (headline numbers)
 *   POST /nlq-eval/publish/<job_id>    -> publish/hyper.publishRun
 *   GET/PUT /nlq-eval/settings/content -> suites/public_content
 *   GET/PUT /nlq-eval/settings/judge   -> db.settings + judge/providers
 *   GET/PUT /nlq-eval/settings/tableau -> db.settings
 *   GET/DELETE /nlq-eval/settings/tableau/connections, POST …/tableau/activate
 *                                      -> db.settings tableau_connections
 *   POST /nlq-eval/preflight           -> tableau/preflight.runPreflight
 *   POST /nlq-eval/run                 -> worker queue + orchestrator
 *   GET  /nlq-eval/events/<job_id>     -> SSE (durable event log)
 *   GET  /nlq-eval/status/<job_id>     -> db.getJobState / db.getRun
 *   GET  /nlq-eval/results/<job_id>    -> db.getFullResults
 *   GET  /results-classic/<job_id>     -> minimal classic page
 *   POST /nlq-eval/cancel/<job_id>     -> control flag
 *   POST /nlq-eval/pause/<job_id>      -> control flag
 *   POST /nlq-eval/resume/<job_id>     -> control flag + re-submit
 *   POST /nlq-eval/batches/<batch>/pause|resume|cancel -> every suite of a batch
 *   DELETE /nlq-eval/results/<job_id>  -> db.deleteRun
 *
 * ## Injected fetch / offline tests
 * Anything reaching Tableau/OpenAI (preflight, publish, judge, CES) goes
 * through injectable `fetch` seams carried on `RoutesDeps`, so route tests run
 * fully offline with a fake harness + injected fetch.
 *
 * ## Module layout (T4.2)
 * This file is the thin assembling factory. The shared state + helpers live in
 * `routes/context.ts` (`createRoutesContext` / `RoutesContext`, plus the pure
 * `json`/`readJson`/`NEVER_STARTED_REASON`). The handlers live in
 * `routes/settings.ts` (settings + capability + preflight) and `routes/runs.ts`
 * (run lifecycle + results). This file wires them via the `routeTable` and owns
 * dispatch (`handle`/`bunRoutes`/`notFound`) and lifecycle (`init`).
 */

import { SseState, toSseFrame } from "@tableau-ai-eval/core";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { JobQueue } from "../worker/queue.ts";
import { type OrchestratorDeps } from "../job/orchestrator.ts";
import type { SuiteBases } from "../suites/catalog.ts";
import type { publishSuiteContent } from "../suites/dashboard_content.ts";
import {
  deleteDashboardContent,
  getDashboardContent,
  postDashboardContentPublish,
} from "./dashboard_content.ts";
import { createRoutesContext, json, NEVER_STARTED_REASON } from "./context.ts";
import { observeRun } from "./observe.ts";
import {
  getContentSettings,
  getJudgeSettings,
  getTableauSettings,
  getTableauConnections,
  postTableauActivate,
  deleteTableauConnection,
  getUiSettings,
  getVersion,
  postPreflight,
  putContentSettings,
  putJudgeSettings,
  putTableauSettings,
} from "./settings.ts";
import {
  deleteResults,
  getDatasetById,
  getDatasetRows,
  getDashboard,
  getDashboardImage,
  getDashboardTitles,
  getDatasets,
  getExport,
  getSummary,
  getResults,
  getResultsClassic,
  getRuns,
  getStatus,
  getSuites,
  postCancel,
  postPause,
  postBatchPause,
  postBatchResume,
  postBatchCancel,
  postPublish,
  postResume,
  postRun,
  putDashboardLocation,
  streamEvents,
} from "./runs.ts";

// ---------------------------------------------------------------------------
// Deps + factory
// ---------------------------------------------------------------------------

export interface RoutesDeps {
  db: AiEvalDb;
  sse: SseState;
  queue: JobQueue;
  /** Suite bases for the catalog (public-suites root etc). */
  suiteBases?: SuiteBases;
  /** The Prep bench folder for the Datasource panel (default: the shipped prep-bench/; null: none). */
  prepRoot?: string | null;
  /** Fetch seam for Tableau preflight/publish/session (offline tests inject). */
  tableauFetch?: typeof fetch;
  /**
   * PEM CA bundle path for Tableau TLS (env TABLEAU_AI_EVAL_CA_BUNDLE / ~/.tableau-ai-eval/ca.pem).
   * Resolved at the app edge and threaded into session/preflight so env is not
   * read deep in the call path. Tests may inject directly.
   */
  caBundlePath?: string;
  /**
   * UI capability signal (from `tableau-ai-eval serve --allow-self-signed` /
   * env TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED). Surfaced via GET /nlq-eval/settings/ui so the
   * frontend reveals the Verify-TLS toggle + CA-bundle field. Does NOT change
   * TLS behavior. Defaults from env at the edge; tests may inject.
   */
  allowSelfSigned?: boolean;
  /** Orchestrator deps overrides (judgeFetch, cesFetch, getAdapter for tests). */
  orchestratorOverrides?: Partial<OrchestratorDeps>;
  /** Injectable id generator (tests pin job ids). */
  genJobId?: () => string;
  /** Publishes a Dashboard Q&A suite's sample content (tests inject a fake). */
  publishSuiteContent?: typeof publishSuiteContent;
  log?: (msg: string, err?: unknown) => void;
}

export interface NlqEvalApp {
  handle(req: Request): Promise<Response>;
  /**
   * The declarative route table shaped for `Bun.serve({ routes })`. Keys are
   * `:id`-style path patterns; values are per-method handler maps. Same source
   * of truth as `handle()`. See the `bunRoutes()` note for the 404 contract
   * (server.ts must also register `/nlq-eval/*` + `/results-classic/*`
   * wildcards → `handle` to preserve JSON-404 on wrong-method/unmatched).
   */
  bunRoutes(): Record<
    string,
    Record<string, (req: Request & { params: Record<string, string> }) => Response | Promise<Response>>
  >;
  /** Orphaned-run recovery + worker start. */
  init(): void;
  readonly deps: RoutesDeps;
}

/** Build the NLQ-eval route handler + lifecycle. */
export function createNlqEvalApp(deps: RoutesDeps): NlqEvalApp {
  const ctx = createRoutesContext(deps);
  const { db, sse, queue } = ctx;

  // -------------------------------------------------------------------------
  // dispatcher — declarative route table (single source of truth)
  // -------------------------------------------------------------------------
  //
  // Each entry is a Bun.serve-style path pattern (`:id` params) + per-method
  // handlers. The SAME table drives (a) the bound server's native
  // `Bun.serve({ routes })` in server.ts and (b) the in-process `handle(req)`
  // seam below (used by tests and app.fetch). Path params arrive URL-decoded to
  // match the previous `decodeURIComponent(match[1])` behavior.
  //
  // 404 contract preserved from the old if/regex chain: an unmatched
  // `/nlq-eval/*` path OR a matched path with an unsupported method both return
  // JSON `{ error: "not found" }` with status 404 (NOT a framework 405).

  type ParamHandler = (
    req: Request,
    params: Record<string, string>,
    url: URL,
  ) => Response | Promise<Response>;

  const routeTable: Array<{
    pattern: string;
    methods: Partial<Record<string, ParamHandler>>;
  }> = [
    {
      pattern: "/nlq-eval/batches/:batch/pause",
      methods: { POST: (_req, p) => postBatchPause(ctx, p.batch) },
    },
    {
      pattern: "/nlq-eval/batches/:batch/resume",
      methods: { POST: (req, p) => postBatchResume(ctx, p.batch, req) },
    },
    {
      pattern: "/nlq-eval/batches/:batch/cancel",
      methods: { POST: (_req, p) => postBatchCancel(ctx, p.batch) },
    },
    {
      pattern: "/nlq-eval/observe/:job",
      methods: { GET: (req, p) => observeRun(ctx, p.job, req) },
    },
    {
      pattern: "/nlq-eval/suites",
      methods: { GET: (_req, _p, url) => getSuites(ctx, url) },
    },
    {
      pattern: "/nlq-eval/dashboards/:job",
      methods: { GET: (_req, p) => getDashboardTitles(ctx, p.job) },
    },
    {
      pattern: "/nlq-eval/dashboards/:job/:case",
      methods: { GET: (_req, p) => getDashboard(ctx, p.job, p.case) },
    },
    {
      pattern: "/nlq-eval/dashboards/:job/:case/image",
      methods: { GET: (_req, p) => getDashboardImage(ctx, p.job, p.case) },
    },
    {
      pattern: "/nlq-eval/dashboards/:job/:case/location",
      methods: { PUT: (req, p) => putDashboardLocation(ctx, p.job, p.case, req) },
    },
    {
      pattern: "/nlq-eval/dashboard-content",
      methods: { GET: () => getDashboardContent(ctx) },
    },
    {
      pattern: "/nlq-eval/dashboard-content/:suite",
      methods: { DELETE: (_req, p) => deleteDashboardContent(ctx, p.suite) },
    },
    {
      pattern: "/nlq-eval/dashboard-content/:suite/publish",
      methods: { POST: (_req, p) => postDashboardContentPublish(ctx, p.suite) },
    },
    {
      pattern: "/nlq-eval/datasets",
      methods: { GET: () => getDatasets(ctx) },
    },
    {
      pattern: "/nlq-eval/datasets/:id",
      methods: { GET: (_req, p) => getDatasetById(ctx, p.id) },
    },
    {
      pattern: "/nlq-eval/datasets/:id/rows",
      methods: { GET: (_req, p, url) => getDatasetRows(ctx, p.id, url) },
    },
    {
      pattern: "/nlq-eval/runs",
      methods: { GET: (_req, _p, url) => getRuns(ctx, url) },
    },
    {
      pattern: "/nlq-eval/settings/ui",
      methods: { GET: () => getUiSettings(ctx) },
    },
    {
      pattern: "/nlq-eval/version",
      methods: { GET: () => getVersion(ctx) },
    },
    {
      pattern: "/nlq-eval/settings/content",
      methods: {
        GET: () => getContentSettings(ctx),
        PUT: (req) => putContentSettings(ctx, req),
      },
    },
    {
      pattern: "/nlq-eval/settings/judge",
      methods: {
        GET: () => getJudgeSettings(ctx),
        PUT: (req) => putJudgeSettings(ctx, req),
      },
    },
    {
      pattern: "/nlq-eval/settings/tableau",
      methods: {
        GET: () => getTableauSettings(ctx),
        PUT: (req) => putTableauSettings(ctx, req),
      },
    },
    {
      pattern: "/nlq-eval/settings/tableau/connections",
      methods: {
        GET: () => getTableauConnections(ctx),
        DELETE: (req) => deleteTableauConnection(ctx, req),
      },
    },
    {
      pattern: "/nlq-eval/settings/tableau/activate",
      methods: { POST: (req) => postTableauActivate(ctx, req) },
    },
    {
      pattern: "/nlq-eval/preflight",
      methods: { POST: (req) => postPreflight(ctx, req) },
    },
    {
      pattern: "/nlq-eval/run",
      methods: { POST: (req) => postRun(ctx, req) },
    },
    {
      pattern: "/nlq-eval/export/:id",
      methods: { GET: (_req, p, url) => getExport(ctx, p.id, url) },
    },
    {
      pattern: "/nlq-eval/summary/:id",
      methods: { GET: (_req, p) => getSummary(ctx, p.id) },
    },
    {
      pattern: "/nlq-eval/publish/:id",
      methods: { POST: (req, p) => postPublish(ctx, p.id, req) },
    },
    {
      pattern: "/nlq-eval/events/:id",
      methods: { GET: (req, p) => streamEvents(ctx, p.id, req) },
    },
    {
      pattern: "/nlq-eval/status/:id",
      methods: { GET: (_req, p) => getStatus(ctx, p.id) },
    },
    {
      pattern: "/nlq-eval/results/:id",
      methods: {
        GET: (_req, p) => getResults(ctx, p.id),
        DELETE: (_req, p) => deleteResults(ctx, p.id),
      },
    },
    {
      pattern: "/results-classic/:id",
      methods: { GET: (_req, p) => getResultsClassic(ctx, p.id) },
    },
    {
      pattern: "/nlq-eval/cancel/:id",
      methods: { POST: (_req, p) => postCancel(ctx, p.id) },
    },
    {
      pattern: "/nlq-eval/pause/:id",
      methods: { POST: (_req, p) => postPause(ctx, p.id) },
    },
    {
      pattern: "/nlq-eval/resume/:id",
      methods: { POST: (req, p) => postResume(ctx, p.id, req) },
    },
  ];

  function notFound(): Response {
    return json({ error: "not found" }, 404);
  }

  // Compile each pattern once. URLPattern lives in Bun's global scope.
  const compiled = routeTable.map((r) => ({
    matcher: new URLPattern({ pathname: r.pattern }),
    methods: r.methods,
  }));

  /**
   * In-process dispatcher, derived from `routeTable`. Matches the request path
   * against the compiled patterns, extracts URL-decoded params, and invokes the
   * method handler — falling through to the shared JSON-404 for an unmatched
   * path or unsupported method. Behavior is identical to the bound server's
   * `Bun.serve({ routes })` because both are generated from the same table.
   */
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    for (const { matcher, methods } of compiled) {
      const match = matcher.exec({ pathname: url.pathname });
      if (!match) continue;
      const fn = methods[req.method];
      if (!fn) return notFound(); // matched path, unsupported method
      const raw = match.pathname.groups as Record<string, string | undefined>;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v !== undefined) params[k] = decodeURIComponent(v);
      }
      return fn(req, params, url);
    }
    return notFound();
  }

  /**
   * The declarative route table shaped for `Bun.serve({ routes })`. Each path
   * maps to a per-method handler object; Bun supplies `req.params` (already
   * URL-decoded — verified), so we pass them straight through (no second
   * decode, which would double-unescape).
   *
   * 404 contract: Bun does NOT return 405 for an unsupported method on a known
   * path — it falls through to a matching wildcard route, else to `fetch`
   * (verified). server.ts registers `/nlq-eval/*` and `/results-classic/*`
   * wildcard routes pointing at `handle()`, so both a wrong method on a known
   * path and an unmatched `/nlq-eval/*` path funnel to the shared JSON-404,
   * exactly like the pre-rewrite dispatcher. This function emits only the
   * positive per-method handlers.
   */
  function bunRoutes(): Record<
    string,
    Record<string, (req: Request & { params: Record<string, string> }) => Response | Promise<Response>>
  > {
    const out: Record<
      string,
      Record<string, (req: Request & { params: Record<string, string> }) => Response | Promise<Response>>
    > = {};
    for (const r of routeTable) {
      const handlers: Record<
        string,
        (req: Request & { params: Record<string, string> }) => Response | Promise<Response>
      > = {};
      for (const [method, fn] of Object.entries(r.methods)) {
        handlers[method] = (req) => {
          const url = new URL(req.url);
          // Bun already URL-decodes params; pass them through unchanged.
          const params = (req.params ?? {}) as Record<string, string>;
          return fn!(req, params, url);
        };
      }
      out[r.pattern] = handlers;
    }
    return out;
  }


  function init(): void {
    db.initDb();
    // Orphaned-run recovery.
    try {
      for (const jobId of db.getActiveRunIds()) {
        const final = db.getJobControl(jobId) === "cancel" ? "cancelled" : "paused";
        ctx.lifecycle.stop(jobId, final);
        sse.appendEvent(jobId, { type: "done", status: final });
      }
      for (const [jobId, st] of Object.entries(db.allJobStates())) {
        if (!["queued", "started", "running"].includes(st.status as string)) continue;
        if (db.getRun(jobId) !== null) continue;
        db.patchJobState(jobId, {
          status: "cancelled",
          never_started: true,
          error: NEVER_STARTED_REASON,
        });
        sse.appendEvent(jobId, { type: "done", status: "cancelled" });
      }
    } catch (err) {
      deps.log?.("Orphaned-run recovery failed", err);
    }
    queue.ensureStarted();
  }

  return { handle, bunRoutes, init, deps };
}

// toSseFrame re-export retained for callers that want the SSE wire frame.
export { toSseFrame };
