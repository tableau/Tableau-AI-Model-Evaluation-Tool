/**
 * Connectivity preflight
 * for connection setup.
 *
 * Setting up the tool against a Tableau Server can fail with a 401 for two
 * completely different reasons that look identical to the admin:
 *
 *   1. the PAT (or site) is wrong — the session itself is refused;
 *   2. the server build does not enable the generations endpoint
 *      (`ECT_EnableGenericEndpoints` off) — sign-in works, but every
 *      generations call 401s.
 *
 * Probe order makes the two distinguishable:
 *
 *   serverinfo (unauthenticated — reachability + product version)
 *     → PAT signin (validates the session)
 *       → generations probe with the seconds-old token
 *         (a 401 here can only be the endpoint, not the session).
 *
 * The response never contains the PAT or any token.
 *
 * ## `ces_url` derivation (fresh / unsaved connections)
 *
 * The generations probe needs a CES base URL. When the caller does not supply
 * `ces_url` we derive it from the request's own `tableau_server`:
 * `<tableau_server rstrip '/'>/content-exploration`. This makes preflight probe
 * generations even on a first-time, never-saved connection — the derivation no
 * longer depends on a previously-stored Tableau connection (the routes layer
 * still fills `ces_url` from a stored connection, but is no longer the ONLY
 * place derivation happens).
 *
 * ## Skipped vs failed (stage semantics)
 *
 * A stage carries `ok` PLUS a `state` discriminator so the UI can render
 * distinct icons instead of collapsing everything into a red X:
 *
 *   - state "ok"      — the stage passed (`ok: true`).
 *   - state "failed"  — a genuine, connection-breaking failure (`ok: false`):
 *                       serverinfo unreachable/non-200, PAT refused, or a REAL
 *                       generations problem (flag_off 401, not_found 404, error,
 *                       unreachable) when `ces_url` IS present and probed.
 *   - state "skipped" — informational, NON-error (`ok: false`, `skipped: true`):
 *                       the stage was not run because a prerequisite failed, or
 *                       (rare, now that we derive it) no `ces_url` could be
 *                       determined. A skipped generations stage does NOT make
 *                       the connection "broken".
 *
 * Top-level `result.ok` reflects whether the connection is USABLE: it is true
 * when server + session both pass, EVEN IF generations was only skipped. When
 * generations is actually probed, a real generations failure flips `result.ok`
 * to false. The UI can therefore
 * show server ✅ / session ✅ / generations ⏭️ as a usable connection.
 *
 * ## TLS (self-signed / private CA)
 *
 * Every probe threads `{verify, caBundlePath}` through {@link tlsInit} (see
 * src/tableau/tls.ts): verify=false disables chain verification; verify=true +
 * a CA bundle trusts a private CA; otherwise default system trust. env is read
 * only at the edge (routes) and passed down — never deep in the call path.
 */

import { TableauAuthError, TableauSession, type FetchLike } from "./session.ts";
import { tlsInit } from "./tls.ts";
import {
  FLAG_OFF_MESSAGE,
  GATEWAY_DISABLED_MESSAGE,
  MIN_RELEASE_LABEL,
  releaseBeforeMinimum,
  releaseLabel,
  tooOldMessage,
} from "./server_support.ts";

export { FLAG_OFF_MESSAGE };

/** CES generations endpoint shared with the embedded bridge. */
export const CES_GENERATIONS_PATH = "/analytics-assistant/v1/generations";

const SERVERINFO_TIMEOUT_MS = 15_000;
const GENERATIONS_PROBE_TIMEOUT_MS = 120_000; // a flag-on probe invokes the site's model
const GENERATIONS_RETRY_DELAY_MS = 3_000; // one retry on 5xx: the site gateway flakes

// siteSettings is only returned from API 3.30+; on 3.22 the payload has no
// such key at all.
const SITE_SETTINGS_API_VERSION = "3.31";

export interface Stage {
  ok: boolean;
  message: string;
  /** UI discriminator: "ok" | "failed" | "skipped". */
  state?: "ok" | "failed" | "skipped";
  /** True when the stage was not genuinely run (informational, not a failure). */
  skipped?: boolean;
  [key: string]: unknown;
}

export interface PreflightConfig {
  tableau_server?: string;
  tableau_site?: string;
  tableau_pat_name?: string;
  pat_name?: string;
  tableau_pat_value?: string;
  pat_value?: string;
  ces_url?: string;
  verify_tls?: boolean;
  /** PEM CA bundle path to trust when verify is true (private/self-signed CA). */
  ca_bundle_path?: string;
}

/** The "release earlier than 2026.3" verdict. */
export interface ServerTooOld {
  /** "2025.3", or null when only a 404 said so (a development build). */
  release: string | null;
  min_release: string;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  /**
   * Tableau Agent in Dashboards on the site: `enabled` true, false,
   * or null when the probe could not tell. Never decides `ok`.
   */
  dashboard_qa?: Stage;
  /**
   * Tableau Agent in Authoring (web authoring) on the site, read the same way:
   * `enabled` true, false, or null when the probe could not tell. The Build a
   * visualization, Calculated fields and Color palettes suites need it. Never
   * decides `ok`.
   */
  web_authoring?: Stage;
  /** Reached and signed in, whatever the AI endpoint said (enough to publish to). */
  connection_ok?: boolean;
  server_too_old?: ServerTooOld;
  server: Stage;
  session: Stage;
  generations: Stage;
  site?: SiteModels | Record<string, never>;
}

interface SiteModels {
  default_models?: boolean;
  models: Array<{ label: string; model: unknown; under_test: boolean }>;
  model_under_test?: unknown;
  provider?: unknown;
  gateway_url?: unknown;
  auth_mode?: unknown;
  /** Site Settings' own Tableau Agent in Dashboards switch, when reported. */
  dashboard_qa_enabled?: boolean | null;
  /** Site Settings' own Tableau Agent in Authoring (web authoring) switch, when reported. */
  web_authoring_enabled?: boolean | null;
}

/** TLS knobs threaded through every probe. */
interface TlsProbeOptions {
  verify: boolean;
  caBundlePath?: string;
}

/**
 * Node/Bun error codes and message fragments that mean "the TLS chain did not
 * verify" (as opposed to the host being unreachable). A browser on the same
 * computer is the operator's oracle, since the tool trusts what the OS trusts.
 */
const CERT_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
  "HOSTNAME_MISMATCH",
]);

function isCertificateError(exc: unknown): boolean {
  const code = (exc as { code?: unknown })?.code;
  if (typeof code === "string" && CERT_ERROR_CODES.has(code)) return true;
  const text = exc instanceof Error ? exc.message : String(exc);
  return /certificate|self[-\s]?signed|self signed|unable to verify|CERT_/i.test(text);
}

/**
 * The one clause worth showing from a TLS verification failure (e.g.
 * "self-signed certificate in certificate chain"), without the connection-pool
 * and C-file noise the underlying library wraps around it.
 */
function certificateReason(exc: unknown): string {
  const code = (exc as { code?: unknown })?.code;
  const text = exc instanceof Error ? exc.message : String(exc);
  let m = text.match(/certificate verify failed:\s*(.+?)\s*(?:\(_ssl|$)/i);
  if (m?.[1]) return m[1].trim();
  m = text.match(/SSLCertVerificationError\((?:\d+,\s*)?['"](.+?)['"]\)/);
  if (m?.[1]) return m[1].trim();
  if (typeof code === "string" && code) return code;
  return "certificate verification failed";
}

function stage(ok: boolean, message: string, extra: Record<string, unknown> = {}): Stage {
  return { ok, message, state: ok ? "ok" : "failed", ...extra };
}

/** A neutral, informational "not run" stage — NOT a connection failure. */
export function skippedStage(message: string, extra: Record<string, unknown> = {}): Stage {
  return { ok: false, message, state: "skipped", skipped: true, reason: "skipped", ...extra };
}

/**
 * A downstream stage that was never attempted, and why. A bare "skipped" tag
 * reads as "nothing wrong here" and hides the one fact the operator needs: the
 * earlier `failedStage` failed, so this one could not run. Names the blocker.
 *
 */
export function notRunBecause(failedStage: string): Stage {
  return skippedStage(
    `Not run because ${failedStage} failed, so this check was not attempted`,
    { blocked_by: failedStage },
  );
}

/** Unauthenticated reachability + version check. */
export async function probeServerinfo(
  serverUrl: string,
  apiVersion: string,
  tls: TlsProbeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<Stage> {
  const url = `${serverUrl.replace(/\/+$/, "")}/api/${apiVersion}/serverinfo`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SERVERINFO_TIMEOUT_MS),
      ...tlsInit({ verify: tls.verify, caBundlePath: tls.caBundlePath }),
    } as RequestInit);
  } catch (exc) {
    if (isCertificateError(exc)) {
      // The most common first-test failure on an on-premises server. The tool
      // trusts what the operating system trusts, so the browser on the same
      // computer is the reader's oracle.
      return stage(
        false,
        `This computer does not trust the certificate ${serverUrl} presents ` +
          `(${certificateReason(exc)}). Open the same address in a browser on this ` +
          "computer: if the browser warns too, ask your Tableau admin for the certificate " +
          "authority's certificate, trust it with `tableau-ai-eval trust <url>`, then restart the " +
          "tool. If the browser opens it without a warning, the certificate authority is " +
          "not on this computer's store: add it, then restart the tool.",
        { reason: "certificate" },
      );
    }
    const msg = exc instanceof Error ? exc.message : String(exc);
    return stage(
      false,
      `Tableau Server is not reachable at ${serverUrl} (${msg}). Check the address ` +
        "and that this computer can reach the server.",
      { reason: "unreachable" },
    );
  }

  if (resp.status !== 200) {
    return stage(
      false,
      `This address didn't answer as a Tableau Server (HTTP ${resp.status}). ` +
        "Check the Tableau Server URL.",
      { status_code: resp.status },
    );
  }

  let productVersion: unknown = null;
  let productBuild: unknown = null;
  let restApiVersion: unknown = null;
  try {
    const body = (await resp.json()) as {
      serverInfo?: {
        productVersion?: { value?: unknown; build?: unknown };
        restApiVersion?: unknown;
      };
    };
    const info = body.serverInfo ?? {};
    productVersion = info.productVersion?.value ?? null;
    productBuild = info.productVersion?.build ?? null;
    restApiVersion = info.restApiVersion ?? null;
  } catch {
    // best-effort version extraction
  }
  const st = stage(true, "Tableau Server reached", {
    product_version: productVersion,
    product_build: productBuild,
    rest_api_version: restApiVersion,
  });
  // The release decides whether the AI endpoint exists at all. Say so on the
  // server stage, where the version is read, so the readout explains the
  // generations failure that follows instead of leaving the admin to infer it
  // from a 404. Development builds report "0.0.0": unknown, and the
  // generations probe is the authority for them.
  const tooOld = releaseBeforeMinimum(productVersion);
  st.release = tooOld !== null ? releaseLabel(productVersion) : null;
  st.release_supported = tooOld === null ? null : !tooOld;
  if (tooOld) {
    st.message =
      `Tableau Server reached, release ${st.release} ` +
      `(the tool needs ${MIN_RELEASE_LABEL} or later)`;
  }
  return st;
}

/**
 * Version and build as one string, "2026.1.0 (20261.26.0415.1010)". The
 * version alone does not identify a server: every development build reports
 * "0.0.0", and two maintenance builds can share a version. The build is the
 * part of the server's About box that tells them apart.
 */
export function serverVersionLabel(st: Record<string, unknown>): string {
  const version = String(st.product_version ?? "").trim();
  const build = String(st.product_build ?? "").trim();
  if (version && build) return `${version} (${build})`;
  return version || build;
}

/** PAT → session token. Mirrors the run-config field aliases. */
export async function probeSignin(
  config: PreflightConfig,
  tls: TlsProbeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<Stage & { _token?: string }> {
  let session: TableauSession;
  let token: string;
  try {
    session = new TableauSession({
      serverUrl: config.tableau_server ?? "",
      patName: config.tableau_pat_name ?? config.pat_name ?? "",
      patSecret: config.tableau_pat_value ?? config.pat_value ?? "",
      siteContentUrl: config.tableau_site ?? "",
      verify: tls.verify,
      caBundlePath: tls.caBundlePath,
      fetchImpl,
    });
    token = await session.getToken();
  } catch (exc) {
    if (exc instanceof TableauAuthError) {
      return stage(
        false,
        "Tableau Server didn't accept the personal access token (PAT): it isn't " +
          "valid, has expired, or doesn't belong to this site. Create a new PAT " +
          "and check the site name.",
        { reason: "pat_invalid" },
      );
    }
    const msg = exc instanceof Error ? exc.message : String(exc);
    return stage(
      false,
      `Tableau Server did not complete the sign-in: ${msg} Try again; if it ` +
        "keeps failing, check that the address is the Tableau Server itself and " +
        "that this computer still reaches it.",
      { reason: "error" },
    );
  }

  const result = stage(true, "Signed in", {
    site_id: session.cachedSiteId,
  }) as Stage & { _token?: string };
  result._token = token; // stripped before the stage is returned to callers
  return result;
}

// Families we can recognise from a model's own self-description.
const FAMILY_MARKERS: Array<[string, string[]]> = [
  ["anthropic", ["claude", "anthropic"]],
  ["openai", ["gpt", "openai", "chatgpt", "o1", "o3"]],
  ["gemini", ["gemini", "google", "bard", "palm"]],
];

export function identifyModel(text: string): {
  model_reply: string;
  model_family: string | null;
} {
  const lowered = (text ?? "").toLowerCase();
  for (const [family, markers] of FAMILY_MARKERS) {
    if (markers.some((m) => lowered.includes(m))) {
      return { model_reply: (text ?? "").trim().slice(0, 200), model_family: family };
    }
  }
  return { model_reply: (text ?? "").trim().slice(0, 200), model_family: null };
}

// The three model slots as Site Settings labels them.
const SITE_MODEL_KEYS: Array<[string, string]> = [
  ["generativeAiQueryParsingModel", "Understand user requests"],
  ["generativeAiVizAndCalcGenerationModel", "Perform analytics tasks"],
  ["generativeAiEmbeddingsModel", "Process data context"],
];

/**
 * Read the site's configured AI models straight from Site Settings.
 * Best-effort: an older server omits `siteSettings` and the caller simply
 * shows nothing rather than failing the connection test.
 *
 * The newest REST version is asked first; a server that does not have it yet
 * (2026.3 stops at 3.30) is asked again at the version it reported
 * (`restApiVersion`), which carries the same settings.
 */
export async function probeSiteModels(
  serverUrl: string,
  token: string,
  siteId: string,
  tls: TlsProbeOptions,
  fetchImpl: FetchLike = fetch,
  restApiVersion?: unknown,
): Promise<SiteModels | Record<string, never>> {
  const versions = [SITE_SETTINGS_API_VERSION];
  if (restApiVersion && !versions.includes(String(restApiVersion))) {
    versions.push(String(restApiVersion));
  }
  let raw: Array<{ key?: string; value?: unknown }> = [];
  try {
    for (const version of versions) {
      const url = `${serverUrl.replace(/\/+$/, "")}/api/${version}/sites/${siteId}`;
      const resp = await fetchImpl(url, {
        headers: { "X-Tableau-Auth": token, Accept: "application/json" },
        signal: AbortSignal.timeout(SERVERINFO_TIMEOUT_MS),
        ...tlsInit({ verify: tls.verify, caBundlePath: tls.caBundlePath }),
      } as RequestInit);
      if (resp.status === 404) continue;
      if (resp.status !== 200) return {};
      const body = (await resp.json()) as {
        site?: { siteSettings?: Array<{ key?: string; value?: unknown }> };
      };
      raw = body.site?.siteSettings ?? [];
      break;
    }
  } catch {
    return {};
  }

  const values = new Map<string, unknown>();
  for (const s of raw) {
    if (s && typeof s === "object" && typeof s.key === "string") {
      values.set(s.key, s.value);
    }
  }

  const models = SITE_MODEL_KEYS.filter(([key]) => values.get(key)).map(
    ([key, label]) => ({
      label,
      model: values.get(key),
      under_test: key === "generativeAiVizAndCalcGenerationModel",
    }),
  );
  const defaultModels = String(values.get("generativeAiIsDefaultOnlineModels") ?? "").toLowerCase() === "true";
  if (models.length === 0 && !defaultModels) return {};
  return {
    models,
    default_models: defaultModels,
    model_under_test: values.get("generativeAiVizAndCalcGenerationModel"),
    provider: values.get("onPremLLMProvider"),
    gateway_url: values.get("hostURL"),
    auth_mode: values.get("onPremLLMAuthMode"),
    // Site Settings' own switch for Tableau Agent in Dashboards, when the
    // server reports it; the endpoint probe is the authority.
    dashboard_qa_enabled:
      values.get("dashboardQAEnabled") == null
        ? null
        : String(values.get("dashboardQAEnabled")).toLowerCase() === "true",
    // Site Settings' switch for Tableau Agent in Authoring: the on-premises
    // key, else Tableau Cloud's. The palette endpoint probe is the authority.
    web_authoring_enabled: siteSwitch(values, ["generativeaiWebauthoringOnPremEnabled", "generativeAiWebAuthoring"]),
  };
}

/** The first of `keys` the site reports, as a boolean; null when none is reported. */
function siteSwitch(values: Map<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    if (values.get(key) != null) return String(values.get(key)).toLowerCase() === "true";
  }
  return null;
}

/**
 * POST a minimal prompt to the generations endpoint with a fresh token.
 * The session was validated seconds ago, so a 401 here is the endpoint itself
 * (flag off / build without it).
 */
export async function probeGenerations(
  cesUrl: string,
  token: string,
  tls: TlsProbeOptions,
  fetchImpl: FetchLike = fetch,
  retryDelayMs: number = GENERATIONS_RETRY_DELAY_MS,
): Promise<Stage> {
  const url = `${cesUrl.replace(/\/+$/, "")}${CES_GENERATIONS_PATH}`;
  const doPost = (): Promise<Response> =>
    fetchImpl(url, {
      method: "POST",
      headers: { "X-Tableau-Auth": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Reply with ONLY your model name and version, nothing else.",
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(GENERATIONS_PROBE_TIMEOUT_MS),
      ...tlsInit({ verify: tls.verify, caBundlePath: tls.caBundlePath }),
    } as RequestInit);

  let resp: Response;
  try {
    resp = await doPost();
    // The site's gateway fails intermittently (observed: 500 "LLM Gateway
    // generations failed" that passes seconds later). One retry keeps a blip
    // from reading as a broken setup; a persistent failure still surfaces below.
    if (resp.status >= 500) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      resp = await doPost();
    }
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return stage(false, `The AI endpoint is not reachable at ${url}: ${msg}`, {
      reason: "unreachable",
    });
  }

  if (resp.status === 200) {
    let text = "";
    try {
      const body = (await resp.json()) as {
        generations?: Array<{ text?: string } | null>;
      };
      const generations = body.generations ?? [];
      text = generations.length ? (generations[0]?.text ?? "") : "";
    } catch {
      // best-effort text extraction
    }
    return stage(true, "AI endpoint responded", {
      status_code: 200,
      ...identifyModel(text),
    });
  }
  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    if (text.toLowerCase().includes("llm gateway is disabled")) {
      return stage(false, GATEWAY_DISABLED_MESSAGE, { reason: "gateway_disabled", status_code: 401 });
    }
    return stage(false, FLAG_OFF_MESSAGE, { reason: "flag_off", status_code: 401 });
  }
  if (resp.status === 404) {
    return stage(false, tooOldMessage(null), { reason: "not_found", status_code: 404 });
  }
  const errText = await resp.text().catch(() => "");
  if (resp.status >= 500) {
    // Sign-in just succeeded, so this is the server's own LLM gateway failing,
    // not the connection. Say where to look.
    return stage(
      false,
      `The site's LLM gateway returned an error (${resp.status}), not your ` +
        "connection to Tableau Server. Test the gateway in Site Settings > AI in " +
        "Tableau; if it passes there, try again in a minute.",
      { reason: "gateway_error", status_code: resp.status },
    );
  }
  return stage(
    false,
    `The AI endpoint returned HTTP ${resp.status}: ${errText.slice(0, 200)}. Try again, ` +
      "and if it keeps failing ask your Tableau admin.",
    { reason: "error", status_code: resp.status },
  );
}

export const CABU_CONVERSATIONS_PATH = "/analytics-assistant/cabu/conversations";
export const DASHBOARD_QA_OFF_MESSAGE =
  "Tableau Agent in Dashboards is turned off for this site, so the Dashboard " +
  "Narratives suite can't run here. A site " +
  "administrator turns it on in Site Settings (Tableau Agent in Dashboards), then " +
  "test the connection again.";
export const DASHBOARD_QA_MISSING_MESSAGE =
  "This Tableau Server build has no Dashboard Q&A endpoint. The suites of this " +
  "release are unaffected.";
const NO_LUID = "00000000-0000-0000-0000-000000000000";
/** The palette endpoint shared with the Color palettes suite; the Authoring probe asks it. */
export const PALETTES_GENERATE_PATH = "/analytics-assistant/color-palettes/generate";
export const WEB_AUTHORING_OFF_MESSAGE =
  "Tableau Agent in Authoring is turned off for this site, so the Build a " +
  "visualization, Calculated fields and Color palettes suites can't run here. A site " +
  "administrator turns it on in Site Settings (Tableau Agent in web authoring), then " +
  "test the connection again.";
const WEB_AUTHORING_PROBE_TIMEOUT_MS = 30_000; // the probe stops at the switch, before any model call

/**
 * Ask the Dashboard Q&A endpoint for a conversation about ids that do not
 * exist. The answer tells the site's state without touching content: a 403
 * naming the site setting means the feature is off; any other answer from the
 * endpoint means it is there and on (the bogus ids are then its complaint); a
 * 404 means the build has no such endpoint.
 *.
 *
 * `enabled` is true, false, or null when the probe could not tell.
 */
export async function probeDashboardQa(
  cesUrl: string,
  token: string,
  tls: TlsProbeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<Stage> {
  const url = `${cesUrl.replace(/\/+$/, "")}${CABU_CONVERSATIONS_PATH}`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "X-Tableau-Auth": token,
        "Content-Type": "application/json",
        Accept: "application/vnd.analytics-assistant.cabu.conversations.v1.0+json",
        Cookie: `workgroup_session_id=${token}; XSRF-TOKEN=tableau-ai-eval`,
      },
      body: JSON.stringify({
        dashboardDatasources: [{ datasourceLuid: NO_LUID }],
        workbookLuid: NO_LUID,
        sessionId: "",
        traceId: "preflight",
        wgSessionId: token,
      }),
      signal: AbortSignal.timeout(GENERATIONS_PROBE_TIMEOUT_MS),
      ...tlsInit({ verify: tls.verify, caBundlePath: tls.caBundlePath }),
    } as RequestInit);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return stage(false, `The Dashboard Q&A endpoint is not reachable at ${url}: ${msg}`, {
      reason: "unreachable",
      enabled: null,
    });
  }
  const body = await resp.text().catch(() => "");
  if (resp.status === 403 && body.toLowerCase().includes("site setting")) {
    return stage(false, DASHBOARD_QA_OFF_MESSAGE, {
      reason: "site_setting_off",
      status_code: 403,
      enabled: false,
    });
  }
  if (resp.status === 404) {
    return stage(false, DASHBOARD_QA_MISSING_MESSAGE, {
      reason: "not_found",
      status_code: 404,
      enabled: false,
    });
  }
  if (resp.status === 401) {
    // The session was minted seconds ago; the endpoint is refusing on its own
    // account. Report it without a verdict rather than guess.
    return stage(false, "The Dashboard Q&A endpoint refused the session (HTTP 401).", {
      reason: "refused",
      status_code: 401,
      enabled: null,
    });
  }
  if (resp.status >= 500) {
    // The feature is on (the request got past the site-setting check) but the
    // service behind it failed. Say so; the suites stay offered, since a run
    // will show the same failure per case if it persists.
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { errorMsg?: unknown } | null;
      detail = String(parsed?.errorMsg || "").trim();
    } catch {
      detail = body.slice(0, 200);
    }
    return stage(
      false,
      "Tableau Agent in Dashboards is turned on, but the server's Dashboard Q&A service " +
        `failed (HTTP ${resp.status}${detail ? `: ${detail}` : ""}). Questions ` +
        "about a dashboard will fail until a Tableau administrator fixes the service.",
      { reason: "service_unavailable", status_code: resp.status, enabled: true },
    );
  }
  return stage(true, "Tableau Agent in Dashboards is turned on for this site", {
    status_code: resp.status,
    enabled: true,
  });
}

/**
 * Ask the palette endpoint for a palette with no utterance. The server checks
 * the Tableau Agent in Authoring site setting before it looks at the
 * utterance, so the answer tells the switch's state without invoking the
 * site's model: a 403 naming the site setting means off; the 400 for the
 * missing utterance (or any other answer from behind the gate) means on. A
 * 501 (palette suggestions flagged off on that build) and a 404 (no palette
 * endpoint) come before the gate and say nothing about the switch: `enabled`
 * is null, and Site Settings' own switch is read instead when the server
 * reports it. The conversations endpoint is gated the same way, but every
 * answer from behind its gate costs a model call.
 */
export async function probeWebAuthoring(
  cesUrl: string,
  token: string,
  tls: TlsProbeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<Stage> {
  const url = `${cesUrl.replace(/\/+$/, "")}${PALETTES_GENERATE_PATH}`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "X-Tableau-Auth": token,
        "Content-Type": "application/json",
        Accept: "application/vnd.analytics-assistant.color-palettes.v1.0+json",
      },
      body: JSON.stringify({ utterance: { content: "" }, paletteType: "regular" }),
      signal: AbortSignal.timeout(WEB_AUTHORING_PROBE_TIMEOUT_MS),
      ...tlsInit({ verify: tls.verify, caBundlePath: tls.caBundlePath }),
    } as RequestInit);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return stage(false, `The Tableau Agent endpoint is not reachable at ${url}: ${msg}`, {
      reason: "unreachable",
      enabled: null,
    });
  }
  const body = await resp.text().catch(() => "");
  if (resp.status === 403 && body.toLowerCase().includes("site setting")) {
    return stage(false, WEB_AUTHORING_OFF_MESSAGE, {
      reason: "site_setting_off",
      status_code: 403,
      enabled: false,
    });
  }
  if (resp.status === 401) {
    return stage(false, "The Tableau Agent endpoint refused the session (HTTP 401).", {
      reason: "refused",
      status_code: 401,
      enabled: null,
    });
  }
  if (resp.status === 404 || resp.status === 501) {
    return stage(
      false,
      (resp.status === 404
        ? "This Tableau Server build has no palette endpoint, "
        : "Color palette suggestions are turned off on this build, ") +
        "so the connection test could not read the Tableau Agent in Authoring switch.",
      { reason: resp.status === 404 ? "not_found" : "flag_off", status_code: resp.status, enabled: null },
    );
  }
  return stage(true, "Tableau Agent in Authoring is turned on for this site", {
    status_code: resp.status,
    enabled: true,
  });
}

/**
 * Run the probes in order, stopping at the first hard failure.
 *
 * `config` uses the same field names as POST /nlq-eval/run:
 * `tableau_server`, `tableau_site`, `tableau_pat_name`/`pat_name`,
 * `tableau_pat_value`/`pat_value`, `ces_url`, optionally `verify_tls`
 * (default true; explicit opt-out for self-signed dev servers only), and
 * optionally `ca_bundle_path` (trust a private CA while keeping verify on).
 * When `ces_url` is blank it is derived from `tableau_server` (see header).
 */
export async function runPreflight(
  config: PreflightConfig,
  fetchImpl: FetchLike = fetch,
  generationsRetryDelayMs: number = GENERATIONS_RETRY_DELAY_MS,
): Promise<PreflightResult> {
  const verify = config.verify_tls ?? true;
  const caBundlePath = config.ca_bundle_path;
  const tls: TlsProbeOptions = { verify, caBundlePath };
  const serverUrl = config.tableau_server ?? "";
  // Derive ces_url from the request's own server when the caller omits it, so
  // a fresh/unsaved connection still probes generations (no stored-connection
  // dependency). `<tableau_server rstrip '/'>/content-exploration`.
  const cesUrl =
    config.ces_url?.trim() ||
    (serverUrl ? serverUrl.replace(/\/+$/, "") + "/content-exploration" : "");

  const result: PreflightResult = {
    ok: false,
    server: skippedStage("not run"),
    session: skippedStage("not run"),
    generations: skippedStage("not run"),
  };

  if (!serverUrl) {
    result.server = stage(
      false,
      "Enter the Tableau Server address first (for example https://tableau.example.com).",
      { reason: "missing" },
    );
    result.session = notRunBecause("Server reachable");
    result.generations = notRunBecause("Server reachable");
    return result;
  }

  result.server = await probeServerinfo(serverUrl, "3.22", tls, fetchImpl);
  if (!result.server.ok) {
    result.session = notRunBecause("Server reachable");
    result.generations = notRunBecause("Server reachable");
    return result;
  }

  const sessionStage = await probeSignin(config, tls, fetchImpl);
  const token = sessionStage._token;
  delete sessionStage._token;
  result.session = sessionStage;
  if (!sessionStage.ok || token === undefined) {
    result.generations = notRunBecause("PAT sign-in");
    return result;
  }

  if (!cesUrl) {
    // No server to derive from — should be rare now that we derive from
    // tableau_server. This is INFORMATIONAL, not a connection failure: server +
    // session both passed, so the connection is usable.
    result.generations = skippedStage(
      "No AI endpoint address was given, so the sign-in was checked but the " +
        "AI endpoint was not.",
    );
    result.ok = true;
    return result;
  }

  const siteId = sessionStage.site_id as string | null | undefined;
  if (siteId) {
    result.site = await probeSiteModels(
      serverUrl,
      token,
      siteId,
      tls,
      fetchImpl,
      result.server.rest_api_version,
    );
  }

  result.generations = await probeGenerations(cesUrl, token, tls, fetchImpl, generationsRetryDelayMs);
  // The connection is usable once server + session pass; a real generations
  // failure (flag_off/not_found/error/unreachable) flips this to false, but a
  // (now-rare) skipped generations stage leaves it true.
  result.ok = result.generations.ok || Boolean(result.generations.skipped);
  // Dashboard Q&A has its own switch (a site setting), independent of the AI
  // endpoint and of the release gate below: a server the AI endpoint answers
  // on is new enough, whatever its version says. Record the switch so the
  // suites that need it can say when a site has it off; it never decides the
  // connection's verdict.
  result.dashboard_qa = await probeDashboardQa(cesUrl, token, tls, fetchImpl);
  if (result.dashboard_qa.enabled == null) {
    // The endpoint could not say; Site Settings' own switch can.
    const siteSwitch = (result.site as SiteModels | undefined)?.dashboard_qa_enabled;
    if (siteSwitch != null) {
      result.dashboard_qa = stage(
        siteSwitch,
        siteSwitch
          ? "Tableau Agent in Dashboards is turned on for this site"
          : DASHBOARD_QA_OFF_MESSAGE,
        { reason: siteSwitch ? null : "site_setting_off", enabled: siteSwitch },
      );
    }
  }
  // Tableau Agent in Authoring (web authoring) is another site setting, read
  // the same way: the Build a visualization, Calculated fields and Color
  // palettes suites need it.
  result.web_authoring = await probeWebAuthoring(cesUrl, token, tls, fetchImpl);
  if (result.web_authoring.enabled == null) {
    const siteSwitch = (result.site as SiteModels | undefined)?.web_authoring_enabled;
    if (siteSwitch != null) {
      result.web_authoring = stage(
        siteSwitch,
        siteSwitch
          ? "Tableau Agent in Authoring is turned on for this site"
          : WEB_AUTHORING_OFF_MESSAGE,
        { reason: siteSwitch ? null : "site_setting_off", enabled: siteSwitch },
      );
    }
  }
  // Reached and signed in: the connection itself works, whatever the AI
  // endpoint said. Publishing needs only this much, and a server too old to
  // evaluate against is still worth saving for that.
  result.connection_ok = true;

  // A release earlier than 2026.3 has no AI endpoint. Two signals say so: the
  // version serverinfo reported, and a 404 from the endpoint itself (the only
  // signal on a development build, which reports "0.0.0"). A probe that
  // succeeded overrides the version: the endpoint is evidently there.
  const version = result.server.product_version;
  const versionOld = result.server.release_supported === false;
  const probe404 = result.generations.reason === "not_found";
  if (!result.ok && (versionOld || probe404)) {
    const message = tooOldMessage(versionOld ? version : null);
    result.server_too_old = {
      release: versionOld ? releaseLabel(version) : null,
      min_release: MIN_RELEASE_LABEL,
      message,
    };
    result.generations.message = message;
    result.generations.reason = "server_too_old";
    return result;
  }

  // A site with no AI models saved has nothing for the gateway to run: the
  // probe comes back 500 and reads as an outage. Name the real cause.
  const siteModels = (result.site as SiteModels | undefined)?.models;
  if (
    !result.ok &&
    result.generations.reason === "gateway_error" &&
    siteId &&
    !(siteModels && siteModels.length)
  ) {
    result.generations.message =
      "This site has no AI models configured. In Site Settings > AI in Tableau, " +
      "choose a provider and a model, save, then test the connection again.";
    result.generations.reason = "site_unconfigured";
  }

  // Cross-check: the site names a model, the gateway answers as one. If the
  // families disagree the gateway is not serving what Site Settings claims.
  const declared = (result.site as SiteModels | undefined)?.model_under_test;
  const answered = result.generations.model_family as string | null | undefined;
  if (declared && answered) {
    const declaredFamily = identifyModel(String(declared)).model_family;
    if (declaredFamily && declaredFamily !== answered) {
      result.generations.family_mismatch = {
        site_settings: declared,
        gateway_answered: answered,
      };
    }
  }
  return result;
}
