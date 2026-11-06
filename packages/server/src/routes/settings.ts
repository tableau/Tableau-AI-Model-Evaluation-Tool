/**
 * Settings + capability route handlers for NLQ-eval.
 *
 * Split out of the old `routes/nlq_eval.ts` god-module (T4.2). Each handler is a
 * plain function taking the shared `RoutesContext` first, then the request bits
 * it needs. Behavior is byte-for-byte identical to the former closures — only
 * the closed-over locals are now reached via `ctx`.
 *
 * Group: getUiSettings, getContentSettings, putContentSettings, getJudgeSettings,
 * putJudgeSettings, getTableauSettings, putTableauSettings, postPreflight.
 * (postPreflight is connection/settings-adjacent, so it lives here.)
 */

import { maskValue, isRedacted } from "@tableau-ai-eval/core";
import { runPreflight, resolveCaBundlePath, serverVersionLabel } from "@tableau-ai-eval/core";
import { PROVIDERS, detectFamily } from "@tableau-ai-eval/core";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import * as publicContent from "../suites/public_content.ts";
import { storedDashboardContent } from "./dashboard_content.ts";
import { VERSION, isCompiled, bundleRoot, resolveDbPath } from "../app.ts";
import { json, readJson, type RoutesContext } from "./context.ts";

/**
 * The job id of a running evaluation that signed in with the same PAT, if any.
 * A Tableau token supports one live session, so a connection test with it would
 * end that run's session mid-suite.
 */
function activeRunUsingToken(ctx: RoutesContext, body: unknown): string | null {
  const b = body as Record<string, unknown>;
  const pat = String(b.tableau_pat_name || b.pat_name || "");
  if (!pat) return null;
  const states = ctx.db.allJobStates();
  for (const [jobId, st] of Object.entries(states)) {
    const status = st.status;
    if (status !== "started" && status !== "running") continue;
    if (st.pat_name && st.pat_name === pat) return jobId;
    const run = ctx.db.getRun(jobId) as { config?: unknown } | null;
    let cfg = run?.config;
    if (typeof cfg === "string") {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = {};
      }
    }
    const c = (cfg as Record<string, unknown>) || {};
    const runPat = String(c.tableau_pat_name || c.pat_name || "");
    if (runPat && runPat === pat) return jobId;
  }
  return null;
}

/**
 * What is running: version, source commit (dev checkout only), and where
 * settings/results live. Shown in the settings drawer so "which build am I on?"
 * has an answer after a pull. + `_build_info`.
 */
export function getVersion(_ctx: RoutesContext): Response {
  const frozen = isCompiled();
  let commit: string | null = null;
  if (!frozen) {
    try {
      const r = spawnSync("git", ["-C", bundleRoot(), "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        timeout: 3000,
      });
      commit = r.status === 0 ? r.stdout.trim() || null : null;
    } catch {
      commit = null;
    }
  }
  let dataDir: string | null = null;
  try {
    dataDir = dirname(resolveDbPath());
  } catch {
    dataDir = null;
  }
  return json({ version: VERSION, commit, frozen, data_dir: dataDir, ca_bundle: resolveCaBundlePath() ?? null });
}

export function getContentSettings(ctx: RoutesContext): Response {
  const conn = ctx.db.getSetting<Record<string, unknown>>("tableau") || {};
  return json({
    pinned_runs: publicContent.pinnedRuns(ctx.settingsStore),
    public_suites_found: publicContent.publicSuitesRoot() !== null,
    // The workbook ids dashboard Q&A last ran against on the connected site,
    // so the set-up form can offer them again.
    dashboard_qa: storedDashboardContent(
      ctx,
      String(conn.server_url || ""),
      String(conn.site || ""),
    ),
  });
}

/**
 * UI capability payload. `allowSelfSigned` tells the frontend to reveal the
 * Verify-TLS toggle + CA-bundle field (which otherwise sit behind devMode).
 * Purely a capability signal — it does not change TLS behavior server-side.
 * `devMode` reflects TABLEAU_AI_EVAL_DEBUG (server debug), left optional/informational.
 */
export function getUiSettings(ctx: RoutesContext): Response {
  const debug =
    process.env.TABLEAU_AI_EVAL_DEBUG === "1" || process.env.TABLEAU_AI_EVAL_DEBUG === "true";
  return json({ allowSelfSigned: ctx.allowSelfSigned, devMode: debug });
}

export async function putContentSettings(ctx: RoutesContext, req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!("pinned_runs" in body)) {
    return json({ error: "pinned_runs must be a list of run ids" }, 400);
  }
  if ("pinned_runs" in body) {
    const ids = body.pinned_runs;
    if (
      !Array.isArray(ids) ||
      !ids.every((i) => typeof i === "string" && i)
    ) {
      return json({ error: "pinned_runs must be a list of run ids" }, 400);
    }
    publicContent.setPinnedRuns(ctx.settingsStore, ids);
  }
  const out: Record<string, unknown> = {};
  if ("pinned_runs" in body) out.pinned_runs = publicContent.pinnedRuns(ctx.settingsStore);
  return json(out);
}

/**
 * The job id of an evaluation that is queued or running, if any. The
 * connection and the evaluator model are frozen while one is in flight
 * (bug bash 2026-10-23, item 22): a run keeps the evaluator model it started
 * with, and a changed connection would sign the run's session away.
 */
export function activeRun(ctx: RoutesContext): string | null {
  for (const [jobId, st] of Object.entries(ctx.db.allJobStates())) {
    if (st.status === "queued" || st.status === "started" || st.status === "running") return jobId;
  }
  return null;
}

/** The stored result of the last connection test, when it is the active connection's. */
function verifiedActiveConnection(ctx: RoutesContext): Record<string, unknown> | null {
  const cfg = ctx.db.getSetting<Record<string, unknown>>("tableau");
  if (!cfg || Object.keys(cfg).length === 0) return null;
  const verified = ctx.db.getSetting<Record<string, unknown>>("tableau_preflight") || {};
  const idA = JSON.stringify(verified.identity ?? null);
  const idB = JSON.stringify(ctx.connectionIdentity(cfg));
  return idA === idB ? verified : null;
}

/**
 * The family of the evaluated model, as the last connection test saw the
 * site's gateway answer (a Claude answer means an Anthropic model, and so
 * on). Null when the connection has not been tested or the answer did not
 * say. Replaces the manual "Evaluated model family" choice (bug bash
 * 2026-10-23, items 5 and 6).
 */
export function evaluatedModelFamily(ctx: RoutesContext): string | null {
  const verified = verifiedActiveConnection(ctx);
  const generations = verified?.generations as Record<string, unknown> | undefined;
  const family = generations?.model_family;
  return typeof family === "string" && family ? family.toLowerCase() : null;
}

export function getJudgeSettings(ctx: RoutesContext): Response {
  const cfg = ctx.db.getSetting<Record<string, unknown>>("judge");
  const evaluatedFamily = evaluatedModelFamily(ctx);
  if (!cfg) return json({ configured: false, evaluated_model_family: evaluatedFamily });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) if (k !== "api_key") out[k] = v;
  out.api_key = maskValue(cfg.api_key || "");
  out.configured = true;
  out.evaluated_model_family = evaluatedFamily;
  // The judge should come from another family than the model under test; a
  // same-family judge is kept with a warning the UI keeps showing.
  // The family comes from the connection test when it saw one, else from the
  // declared family (a dev-mode override).
  const family = evaluatedFamily || cfg.model_under_test_family;
  out.same_family_warning = Boolean(family && family === cfg.provider);
  return json(out);
}

/**
 * PUT /nlq-eval/settings/judge. The judge should be a different model family
 * than the model under test (Jul 29 review). A judge from the declared family
 * is accepted with a `warnings` entry rather than rejected (UX review
 * 2026-09-24: warn, do not block); the GET payload carries
 * `same_family_warning` so the UI can keep showing it.
 */
export async function putJudgeSettings(ctx: RoutesContext, req: Request): Promise<Response> {
  const body = await readJson(req);
  const running = activeRun(ctx);
  if (running) {
    return json(
      {
        error:
          "An evaluation is running. Pause or stop it to change the evaluator model; " +
          "a run keeps the evaluator model it started with.",
        reason: "run_in_progress",
        job_id: running,
      },
      409,
    );
  }
  const provider = String(body.provider || "").toLowerCase().trim();
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    return json({ error: `Choose the evaluator model's provider: one of ${PROVIDERS.join(", ")}.` }, 400);
  }
  const model = String(body.model || "").trim();
  if (!model) {
    return json(
      { error: "Enter the evaluator model's name, as the provider names it (for example gpt-6.1-sol)." },
      400,
    );
  }
  const modelFamily = detectFamily(model);
  if (modelFamily && modelFamily !== provider) {
    return json(
      { error: `model '${model}' looks like a ${modelFamily} model, not ${provider}` },
      400,
    );
  }
  const existing = ctx.db.getSetting<Record<string, unknown>>("judge") || {};
  let apiKey = String(body.api_key || "");
  if (isRedacted(apiKey)) {
    // The masked value stands for the stored key, which belongs to the
    // provider it was saved with. Keeping it across a provider change saved
    // an OpenAI key under Anthropic on 2026-10-13 ("invalid x-api-key" on
    // every judge call).
    if (existing.api_key && existing.provider !== provider) {
      return json(
        {
          error:
            `The stored API key is for ${existing.provider}. Enter the ` +
            `API key for ${provider} to switch the evaluator model's provider.`,
        },
        400,
      );
    }
    apiKey = (existing.api_key as string) || "";
  }
  if (!apiKey) {
    return json(
      {
        error:
          "Enter the API key for the evaluator model's provider. The tool stores it on this " +
          "computer and never sends it anywhere but to that provider.",
      },
      400,
    );
  }

  const mutFamily = String(
    body.model_under_test_family || existing.model_under_test_family || "",
  )
    .toLowerCase()
    .trim();
  const warnings: string[] = [];
  const evaluatedFamily = evaluatedModelFamily(ctx) || mutFamily;
  if (evaluatedFamily && evaluatedFamily === provider) {
    warnings.push(
      `The evaluator model is a ${provider} model and the evaluated model is ` +
        `a ${evaluatedFamily} model: a model evaluating its own family tends ` +
        "to favor it. Evaluator scores carry this warning until you pick an " +
        "evaluator model from a different provider.",
    );
  }
  ctx.db.setSetting("judge", {
    provider,
    model,
    api_key: apiKey,
    model_under_test_family: mutFamily,
  });
  return json({ ok: true, provider, model, warnings });
}

export function getTableauSettings(ctx: RoutesContext): Response {
  const cfg = ctx.db.getSetting<Record<string, unknown>>("tableau");
  // A forgotten active connection is stored as {}: not configured.
  if (!cfg || Object.keys(cfg).length === 0) return json({ configured: false });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) if (k !== "pat_value") out[k] = v;
  out.pat_value = maskValue(cfg.pat_value || "");
  out.configured = true;
  const verified = ctx.db.getSetting<Record<string, unknown>>("tableau_preflight") || {};
  const idA = JSON.stringify(verified.identity ?? null);
  const idB = JSON.stringify(ctx.connectionIdentity(cfg));
  if (idA === idB) {
    out.last_verified = {
      ok: verified.ok,
      at: verified.at,
      failed_stage: verified.failed_stage,
      model_under_test: verified.model_under_test,
      connection_ok: verified.connection_ok ?? verified.ok,
      server_version: verified.server_version,
      server_too_old: verified.server_too_old,
      dashboard_qa: verified.dashboard_qa,
      web_authoring: verified.web_authoring,
      generations: verified.generations,
      default_models: Boolean(verified.default_models),
    };
  } else {
    out.last_verified = null;
  }
  out.saved_connections = savedConnectionsMasked(ctx);
  return json(out);
}

// ---------------------------------------------------------------------------
// Saved connections. The tool still runs against ONE
// connection at a time (the `tableau` setting); every connection ever saved is
// also kept in `tableau_connections`, with its own last verification, so an
// admin who evaluates several servers or sites switches between them instead
// of re-entering each token.
// ---------------------------------------------------------------------------

type Conn = Record<string, unknown>;

function connectionKeyOf(c: Conn): string {
  return JSON.stringify([
    String(c.server_url || "").trim().replace(/\/+$/, "").toLowerCase(),
    String(c.site || "").trim(),
  ]);
}

function sameConnection(a: Conn, b: Conn): boolean {
  return connectionKeyOf(a) === connectionKeyOf(b);
}

function withoutVerification(c: Conn): Conn {
  const out: Conn = {};
  for (const [k, v] of Object.entries(c)) if (k !== "last_verified") out[k] = v;
  return out;
}

function savedConnections(ctx: RoutesContext): Conn[] {
  const stored = ctx.db.getSetting<unknown>("tableau_connections");
  const saved = (Array.isArray(stored) ? stored : []).filter(
    (c): c is Conn => Boolean(c) && typeof c === "object" && !Array.isArray(c) && Boolean((c as Conn).server_url),
  );
  // A connection saved before the list existed is the list's first entry, with
  // the verification recorded for it.
  const active = ctx.db.getSetting<Conn>("tableau") || {};
  if (active.server_url && !saved.some((c) => sameConnection(c, active))) {
    const verified = ctx.db.getSetting<Conn>("tableau_preflight") || {};
    const matches =
      JSON.stringify(verified.identity ?? null) === JSON.stringify(ctx.connectionIdentity(active));
    saved.push({ ...active, last_verified: matches ? verified : null });
    ctx.db.setSetting("tableau_connections", saved);
  }
  return saved;
}

function upsertSavedConnection(ctx: RoutesContext, cfg: Conn): void {
  const before = savedConnections(ctx);
  const previous = before.find((c) => sameConnection(c, cfg));
  const saved = before.filter((c) => !sameConnection(c, cfg));
  saved.push({ ...withoutVerification(cfg), last_verified: previous?.last_verified ?? null });
  ctx.db.setSetting("tableau_connections", saved);
}

function recordVerificationOnSaved(ctx: RoutesContext, record: Conn): void {
  const saved = savedConnections(ctx);
  const identity = JSON.stringify(record.identity ?? null);
  for (const c of saved) {
    if (JSON.stringify(ctx.connectionIdentity(c)) === identity) c.last_verified = record;
  }
  ctx.db.setSetting("tableau_connections", saved);
}

function savedConnectionsMasked(ctx: RoutesContext): Conn[] {
  const active = ctx.db.getSetting<Conn>("tableau") || {};
  const hasActive = Object.keys(active).length > 0;
  return savedConnections(ctx).map((c) => {
    const verified = (c.last_verified as Conn | null) || null;
    return {
      server_url: c.server_url ?? "",
      site: c.site ?? "",
      pat_name: c.pat_name ?? "",
      pat_value: maskValue(c.pat_value || ""),
      verify_tls: c.verify_tls ?? true,
      ces_url: c.ces_url ?? "",
      active: hasActive && sameConnection(c, active),
      last_verified:
        verified && Object.keys(verified).length > 0
          ? {
              ok: verified.ok,
              at: verified.at,
              server_version: verified.server_version,
              model_under_test: verified.model_under_test,
              dashboard_qa: verified.dashboard_qa,
              web_authoring: verified.web_authoring,
              connection_ok: verified.connection_ok ?? verified.ok,
              default_models: Boolean(verified.default_models),
            }
          : null,
    };
  });
}

const UNKNOWN_CONNECTION = {
  error: "No saved connection matches that server and site.",
  reason: "unknown_connection",
};

/** GET /nlq-eval/settings/tableau/connections: every saved connection, tokens masked. */
export function getTableauConnections(ctx: RoutesContext): Response {
  return json({ connections: savedConnectionsMasked(ctx) });
}

/**
 * POST /nlq-eval/settings/tableau/activate: make a saved connection the one
 * the tool runs against. Its own last verification comes back with it, so a
 * connection tested last week is ready to evaluate again without a new test.
 */
export async function postTableauActivate(ctx: RoutesContext, req: Request): Promise<Response> {
  const body = await readJson(req);
  const match = savedConnections(ctx).find((c) => sameConnection(c, body));
  if (!match) return json(UNKNOWN_CONNECTION, 404);
  ctx.db.setSetting("tableau", withoutVerification(match));
  ctx.db.setSetting("tableau_preflight", (match.last_verified as Conn | null) || {});
  return getTableauSettings(ctx);
}

/**
 * DELETE /nlq-eval/settings/tableau/connections: forget a saved connection.
 * Forgetting the active one leaves the tool unconnected until another is
 * chosen or entered.
 */
export async function deleteTableauConnection(ctx: RoutesContext, req: Request): Promise<Response> {
  const body = await readJson(req);
  const saved = savedConnections(ctx);
  const keep = saved.filter((c) => !sameConnection(c, body));
  if (keep.length === saved.length) return json(UNKNOWN_CONNECTION, 404);
  ctx.db.setSetting("tableau_connections", keep);
  const active = ctx.db.getSetting<Conn>("tableau") || {};
  if (Object.keys(active).length > 0 && sameConnection(active, body)) {
    ctx.db.setSetting("tableau", {});
    ctx.db.setSetting("tableau_preflight", {});
  }
  return json({ ok: true, connections: savedConnectionsMasked(ctx) });
}

export async function putTableauSettings(ctx: RoutesContext, req: Request): Promise<Response> {
  const body = await readJson(req);
  const running = activeRun(ctx);
  if (running) {
    return json(
      {
        error: "An evaluation is running. Pause or stop it to change the connection.",
        reason: "run_in_progress",
        job_id: running,
      },
      409,
    );
  }
  const serverUrl = String(body.server_url || "").trim().replace(/\/+$/, "");
  if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
    return json(
      {
        error:
          "Enter the Tableau Server address starting with http:// or https://, " +
          "for example https://tableau.example.com.",
      },
      400,
    );
  }
  const existing = ctx.db.getSetting<Record<string, unknown>>("tableau") || {};
  const patName = String(body.pat_name || "").trim();
  // The PAT secret is masked (****xxxx) on GET, so a re-save round-trips the
  // mask. Treat an ABSENT or MASKED pat_value as "keep the stored secret" —
  // only a real, non-masked value replaces it.
  const patProvided = body.pat_value !== undefined && body.pat_value !== null;
  let patValue = String(body.pat_value || "");
  if (!patProvided || isRedacted(patValue))
    patValue = (existing.pat_value as string) || "";
  if (!patName || !patValue)
    return json(
      {
        error:
          "Enter the personal access token's name (exactly as Tableau shows it) " +
          "and its secret.",
      },
      400,
    );
  const cfg = {
    server_url: serverUrl,
    site: String(body.site || "").trim(),
    pat_name: patName,
    pat_value: patValue,
    verify_tls: Boolean(body.verify_tls ?? true),
    ces_url: String(body.ces_url || "").trim().replace(/\/+$/, ""),
    declared_model: String(body.declared_model || "").trim(),
  };
  ctx.db.setSetting("tableau", cfg);
  upsertSavedConnection(ctx, cfg);
  return json({ ok: true, server_url: serverUrl, site: cfg.site });
}

export async function postPreflight(ctx: RoutesContext, req: Request): Promise<Response> {
  const body = ctx.mergeTableauSettings(await readJson(req));
  // Refuse to test the connection while a running evaluation uses the same PAT:
  // signing in again with that token would end the run's session (a token
  // supports one live session).
  const clash = activeRunUsingToken(ctx, body);
  if (clash) {
    const pat =
      String((body as Record<string, unknown>).tableau_pat_name || "") ||
      String((body as Record<string, unknown>).pat_name || "");
    return json(
      {
        error:
          `An evaluation (${clash.slice(0, 8)}) is running with the token "${pat}". ` +
          "Testing the connection signs in again with that token, which ends the " +
          "running evaluation's session (a token supports one live session). Pause " +
          "the evaluation first, or test with a different token.",
        job_id: clash,
      },
      409,
    );
  }
  // Thread the edge-resolved CA bundle into the probes (session + generations
  // trust a private CA when verify stays on). Only when the caller did not
  // already specify one.
  if (ctx.caBundlePath && !(body as Record<string, unknown>).ca_bundle_path) {
    (body as Record<string, unknown>).ca_bundle_path = ctx.caBundlePath;
  }
  const result = await runPreflight(body as never, ctx.deps.tableauFetch);
  const resultObj = result as unknown as Record<string, unknown>;
  // record preflight verification next to the connection
  const failed =
    (["server", "session", "generations"] as const).find((name) => {
      const s = resultObj[name] as Record<string, unknown> | undefined;
      return s && !s.ok && s.reason !== "skipped";
    }) ?? null;
  const record = {
    ok: Boolean(result.ok),
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    identity: ctx.connectionIdentity(body),
    failed_stage: failed,
    model_under_test:
      (resultObj.site as Record<string, unknown>)?.model_under_test ?? null,
    site_id: result.session.site_id ?? null,
    default_models: Boolean((resultObj.site as Record<string, unknown>)?.default_models),
    generations: result.generations ? {
      ok: Boolean(result.generations.ok),
      reason: result.generations.reason ?? null,
      message: result.generations.message,
    } : null,
    // Reached and signed in, whatever the AI endpoint said: enough to publish
    // to, and the state a release earlier than 2026.3 is left in.
    connection_ok: Boolean(result.connection_ok),
    server_version: serverVersionLabel(result.server) || null,
    server_too_old: result.server_too_old ?? null,
    // Tableau Agent in Dashboards on the site: true, false, or null when the
    // probe could not tell. Read by the suite list and the run request.
    dashboard_qa: result.dashboard_qa
      ? { enabled: result.dashboard_qa.enabled ?? null, message: result.dashboard_qa.message ?? null }
      : null,
    // Tableau Agent in Authoring on the site, the same way: read by the suite
    // list and the run request for the suites the server gates on it.
    web_authoring: result.web_authoring
      ? { enabled: result.web_authoring.enabled ?? null, message: result.web_authoring.message ?? null }
      : null,
  };
  ctx.db.setSetting("tableau_preflight", record);
  recordVerificationOnSaved(ctx, record);
  return json(result);
}
