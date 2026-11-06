/**
 * Shared context + pure HTTP helpers for the NLQ-eval routes.
 *
 * `createNlqEvalApp` (routes/nlq_eval.ts) used to build a big set of handler
 * closures that captured a common set of locals (db/sse/queue/jobConfigs, the
 * edge-resolved caBundlePath/allowSelfSigned, settingsStore/orchestratorDeps)
 * plus a handful of stateful helpers (readState/writeState/connectionIdentity/
 * mergeTableauSettings/makeSession). Those are collected here
 * into a single `RoutesContext` value threaded explicitly into each handler, so
 * the handlers can live in focused modules (settings.ts / runs.ts) instead of
 * one god-module. This is an organizational split only — no behavior change.
 */

import { resolveCaBundlePath } from "@tableau-ai-eval/core";
import { SseState } from "@tableau-ai-eval/core";
import { DASHBOARD_QA_OFF_MESSAGE, TableauSession, WEB_AUTHORING_OFF_MESSAGE } from "@tableau-ai-eval/core";
import type { RunConfig } from "@tableau-ai-eval/core";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { RunLifecycle } from "@tableau-ai-eval/core";
import { JobQueue } from "../worker/queue.ts";
import { type OrchestratorDeps } from "../job/orchestrator.ts";
import type { SettingsStore } from "../suites/public_content.ts";
import type { RoutesDeps } from "./nlq_eval.ts";

// In-memory config cache for resume. Holds the raw config — including
// secrets — for the process lifetime only; never persisted (runs.config is
// redacted at rest). Keyed per app instance.
type JsonBody = Record<string, unknown>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export async function readJson(req: Request): Promise<JsonBody> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as JsonBody) : {};
  } catch {
    return {};
  }
}

export const UNKNOWN_JOB_MESSAGE =
  "No evaluation with this id exists on this computer. It may have been " +
  "deleted, or the link may belong to another computer's copy of the tool.";

/** 404 for a job id this tool does not know. */
export function unknownJob(): Response {
  return json({ error: UNKNOWN_JOB_MESSAGE, reason: "unknown_job" }, 404);
}

/** The recorded "release earlier than 2026.3" verdict (see `serverTooOldFor`). */
export interface ServerTooOldVerdict {
  release: string | null;
  min_release: string;
  message: string;
}

export const NEVER_STARTED_REASON =
  "This evaluation never started: the tool was restarted while it was " +
  "still waiting its turn. Evaluate it again from the home page.";

/**
 * Shared state + helpers threaded into every route handler. Built by
 * `createRoutesContext` from `RoutesDeps` exactly as `createNlqEvalApp` did.
 */
export interface RoutesContext {
  db: AiEvalDb;
  sse: SseState;
  lifecycle: RunLifecycle;
  queue: JobQueue;
  jobConfigs: Map<string, RunConfig>;
  genJobId: () => string;
  caBundlePath?: string;
  allowSelfSigned: boolean;
  settingsStore: SettingsStore;
  orchestratorDeps: OrchestratorDeps;
  deps: RoutesDeps;
  readState(jobId: string): Record<string, unknown>;
  writeState(jobId: string, patch: Record<string, unknown>): void;
  connectionIdentity(cfg: Record<string, unknown>): string[];
  mergeTableauSettings(config: RunConfig): RunConfig;
  makeSession(body: Record<string, unknown>): TableauSession;
  serverTooOldFor(config: Record<string, unknown>): ServerTooOldVerdict | null;
  dashboardQaOffFor(config: Record<string, unknown>): { message: string; reason?: string } | null;
  /** The recorded "Tableau Agent in Authoring is off" verdict for the connection `config` names, else null. */
  webAuthoringOffFor(config: Record<string, unknown>): { message: string } | null;
  aiEndpointOffFor(config: Record<string, unknown>): { message: string; reason: unknown } | null;
}

/** Build the shared routes context (state + helpers) from RoutesDeps. */
export function createRoutesContext(deps: RoutesDeps): RoutesContext {
  const { db, sse, queue } = deps;
  const lifecycle = new RunLifecycle(db, sse);
  const jobConfigs = new Map<string, RunConfig>();
  const genJobId = deps.genJobId ?? (() => crypto.randomUUID().replace(/-/g, ""));
  // Resolve the CA bundle once at the edge (explicit dep > env/auto-detect).
  const caBundlePath = deps.caBundlePath ?? resolveCaBundlePath();
  // UI capability: explicit dep > env TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED.
  const allowSelfSigned =
    deps.allowSelfSigned ??
    (process.env.TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED === "1" ||
      process.env.TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED === "true");

  const settingsStore: SettingsStore = {
    getSetting: (k) => db.getSetting(k),
    setSetting: (k, v) => db.setSetting(k, v),
  };

  const orchestratorDeps: OrchestratorDeps = {
    db,
    sse,
    log: deps.log,
    ...deps.orchestratorOverrides,
    cesFetch: deps.orchestratorOverrides?.cesFetch ?? deps.tableauFetch,
    runControllers: new Map(),
    lifecycle,
  };

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function readState(jobId: string): Record<string, unknown> {
    return db.getJobState(jobId);
  }
  function writeState(jobId: string, patch: Record<string, unknown>): void {
    lifecycle.patch(jobId, patch);
  }

  function connectionIdentity(cfg: Record<string, unknown>): string[] {
    const server =
      ((cfg.server_url as string) || (cfg.tableau_server as string) || "").replace(/\/+$/, "");
    const site = (cfg.site as string) || (cfg.tableau_site as string) || "";
    const pat = (cfg.pat_name as string) || (cfg.tableau_pat_name as string) || "";
    return [server, site, pat];
  }

  function mergeTableauSettings(config: RunConfig): RunConfig {
    let stored = db.getSetting<Record<string, unknown>>("tableau") || {};
    const absent = (...keys: string[]): boolean => {
      for (const k of keys) {
        const v = config[k];
        const sv = typeof v === "string" ? v.trim() : v;
        if (sv && !String(sv).startsWith("****")) return false;
      }
      return true;
    };
    if (!absent("tableau_server")) {
      const server = String(config.tableau_server).replace(/\/+$/, "");
      const site = String(config.tableau_site || "");
      const matches = (c: Record<string, unknown>) =>
        String(c.server_url || "").replace(/\/+$/, "") === server && String(c.site || "") === site;
      if (!matches(stored)) {
        const saved = db.getSetting<Record<string, unknown>[]>("tableau_connections") || [];
        stored = saved.find(matches) || {};
      }
    }
    if (Object.keys(stored).length) {
      if (absent("tableau_server")) config.tableau_server = stored.server_url || "";
      if (absent("tableau_site")) config.tableau_site = stored.site || "";
      if (absent("tableau_pat_name", "pat_name"))
        config.tableau_pat_name = stored.pat_name || "";
      if (absent("tableau_pat_value", "pat_value"))
        config.tableau_pat_value = stored.pat_value || "";
      if (config.verify_tls === undefined || config.verify_tls === null)
        config.verify_tls = (stored.verify_tls as boolean) ?? true;
      if (absent("declared_site_model") && stored.declared_model)
        config.declared_site_model = stored.declared_model;
    }
    // The content-exploration service lives on the Tableau Server itself, so its
    // address follows from the server's. This must work with nothing stored yet:
    // on first setup the form sends only the server URL. Derive from the server
    // in THIS request so testing a new URL probes the new server — and only
    // reuse a stored ces_url when the request targets the SAME stored server.
    if (!String(config.ces_url || "").trim()) {
      const server = String(config.tableau_server || "").trim();
      const sameServer =
        server.replace(/\/+$/, "") ===
        String(stored.server_url || "").trim().replace(/\/+$/, "");
      const storedCes = sameServer ? (stored.ces_url as string) : "";
      const derived =
        storedCes || (server ? `${server.replace(/\/+$/, "")}/content-exploration` : "");
      if (derived) config.ces_url = derived;
    }
    return config;
  }


  function makeSession(body: Record<string, unknown>): TableauSession {
    return new TableauSession({
      serverUrl: (body.tableau_server as string) || "",
      patName: (body.pat_name as string) || (body.tableau_pat_name as string) || "",
      patSecret: (body.pat_value as string) || (body.tableau_pat_value as string) || "",
      siteContentUrl: (body.tableau_site as string) || "",
      verify: (body.verify_tls as boolean) ?? true,
      caBundlePath,
      fetchImpl: deps.tableauFetch,
    });
  }

  /**
   * The recorded "release earlier than 2026.3" verdict for the connection this
   * config will use, or null when the last connection test did not say so (or
   * was for another connection). The verdict is stored by the connection test;
   * nothing here talks to the server.
   */
  function serverTooOldFor(config: Record<string, unknown>): ServerTooOldVerdict | null {
    const verified = db.getSetting<Record<string, unknown>>("tableau_preflight") || {};
    if (!verified.server_too_old) return null;
    if (JSON.stringify(verified.identity ?? null) !== JSON.stringify(connectionIdentity(config)))
      return null;
    return verified.server_too_old as ServerTooOldVerdict;
  }

  /**
   * The recorded "Tableau Agent in Dashboards is off" verdict for the
   * connection this config will use, or null when the last connection test
   * found it on, could not tell, or was for another connection.
   */
  function dashboardQaOffFor(config: Record<string, unknown>): { message: string; reason?: string } | null {
    const verified = db.getSetting<Record<string, unknown>>("tableau_preflight") || {};
    const state = (verified.dashboard_qa || {}) as Record<string, unknown>;
    if (state.enabled !== false) return null;
    if (JSON.stringify(verified.identity ?? null) !== JSON.stringify(connectionIdentity(config)))
      return null;
    return {
      message: (state.message as string) || DASHBOARD_QA_OFF_MESSAGE,
      ...(state.reason ? { reason: String(state.reason) } : {}),
    };
  }

  /**
   * The recorded "Tableau Agent in Authoring is off" verdict for the
   * connection this config will use, or null when the last connection test
   * found it on, could not tell, or was for another connection.
   */
  function webAuthoringOffFor(config: Record<string, unknown>): { message: string } | null {
    const verified = db.getSetting<Record<string, unknown>>("tableau_preflight") || {};
    const state = (verified.web_authoring || {}) as Record<string, unknown>;
    if (state.enabled !== false) return null;
    if (JSON.stringify(verified.identity ?? null) !== JSON.stringify(connectionIdentity(config)))
      return null;
    return { message: (state.message as string) || WEB_AUTHORING_OFF_MESSAGE };
  }

  function aiEndpointOffFor(config: Record<string, unknown>): { message: string; reason: unknown } | null {
    const verified = db.getSetting<Record<string, unknown>>("tableau_preflight") || {};
    if (!verified.connection_ok || verified.ok) return null;
    if (JSON.stringify(verified.identity) !== JSON.stringify(connectionIdentity(config))) return null;
    const state = (verified.generations || {}) as Record<string, unknown>;
    if (state.ok !== false) return null;
    return { message: String(state.message || "The site's generic AI endpoint is unavailable."), reason: state.reason };
  }

  return {
    db,
    sse,
    lifecycle,
    queue,
    jobConfigs,
    genJobId,
    caBundlePath,
    allowSelfSigned,
    settingsStore,
    orchestratorDeps,
    deps,
    readState,
    writeState,
    connectionIdentity,
    mergeTableauSettings,
    makeSession,
    serverTooOldFor,
    dashboardQaOffFor,
    webAuthoringOffFor,
    aiEndpointOffFor,
  };
}
