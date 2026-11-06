/**
 * Credential handling plus
 * secret-redaction logic for persisted settings.
 *
 * Two responsibilities, kept together because they both touch secrets:
 *
 *  1. **Load / validate / build** the credential payloads the runners consume
 *     (LLM `llm.json`, Tableau `byollm.json`), including the `_runner_base_url`
 *     suffix-strip and the schemeless-URL / placeholder-key refusals.
 *  2. **Redact** — never expose secrets. `redactSecrets` masks secret-named
 *     values recursively (for display/audit records), and `loadConfigFile`
 *     parses the local `./config` file used by the live smoke without ever
 *     returning or logging the raw secret to a caller that didn't ask for it.
 *
 * Returns payload objects without writing credential files or changing the
 * process working directory.
 */

// ---------------------------------------------------------------------------
// Secret redaction.
// ---------------------------------------------------------------------------

const SECRET_KEY_EXACT = new Set([
  "llm_key",
  "llmkey",
  "judge_llm_key",
  "pat_value",
  "tableau_pat_value",
  "api_key",
  "apikey",
  "authorization",
  "secret",
  "password",
]);
const SECRET_KEY_SUFFIXES = ["_key", "_secret", "_token", "_password"];

function isSecretKey(key: string): boolean {
  const kl = key.toLowerCase();
  return SECRET_KEY_EXACT.has(kl) || SECRET_KEY_SUFFIXES.some((s) => kl.endsWith(s));
}

/** Mask a single value: `****` + last-4 for longer strings, `****` otherwise. */
export function maskValue(v: unknown): unknown {
  if (typeof v === "string" && v) {
    return v.length > 8 ? `****${v.slice(-4)}` : "****";
  }
  if (v) return "****";
  return v;
}

/**
 * Return a copy of `obj` with secret-named values masked, recursively.
 * Applies at every nesting level so header dicts (e.g. `gateway_headers`
 * containing `Authorization`) are covered too.
 */
export function redactSecrets(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map((x) => redactSecrets(x));
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? maskValue(val) : redactSecrets(val);
    }
    return out;
  }
  return obj;
}

/** True if a value is a redaction placeholder (`****…`) rather than a real secret. */
export function isRedacted(v: unknown): boolean {
  return typeof v === "string" && v.startsWith("****");
}

// ---------------------------------------------------------------------------
// Credential payload build / validate.
// ---------------------------------------------------------------------------

export interface LlmCredentials {
  llmUrl: string;
  llmKey: string;
  orgId: string;
  certPath?: string;
}

export interface TableauCredentials {
  server: string;
  site?: string;
  pat_name?: string;
  pat_value?: string;
}

const PLACEHOLDER_KEYS = new Set(["generativeAiLLMProviderAPIKeySet", ""]);

function hasScheme(url: unknown): url is string {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

/**
 * Return the base URL CES-conversation runners sign in against.
 *
 * Runners build URLs as `credentials.server + endpoint_mapping`, and every
 * mapping already starts with `/content-exploration`. The stored `ces_url` is
 * the CES root (`<server>/content-exploration`); we strip that suffix so the
 * runner URL doesn't double the prefix (which makes the gateway answer 403).
 * A standalone dev CES (`http://localhost:8080`) carries no suffix and is
 * returned unchanged.
 */
export function runnerBaseUrl(cesUrl: string | undefined | null): string {
  const trimmed = (cesUrl ?? "").replace(/\/+$/, "");
  const suffix = "/content-exploration";
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}

/**
 * Build the LLM credential payload consumed by the NLQ runner.
 * Returns `null` when the input should be skipped (placeholder key or a
 * schemeless gateway URL) — the caller preserves any existing file.
 */
export function buildLlmCredentials(config: {
  gateway_url?: string;
  llm_key?: string;
  org_id?: string;
  cert_path?: string;
}): { payload: LlmCredentials } | { skip: "placeholder" | "schemeless" | "missing" } {
  const gatewayUrl = config.gateway_url ?? "";
  const llmKey = config.llm_key ?? "";
  const orgId = config.org_id ?? "";
  const certPath = config.cert_path;

  const scheme = hasScheme(gatewayUrl);
  if (gatewayUrl && llmKey && !PLACEHOLDER_KEYS.has(llmKey) && scheme) {
    const payload: LlmCredentials = { llmUrl: gatewayUrl, llmKey, orgId };
    if (certPath) payload.certPath = certPath;
    return { payload };
  }
  if (gatewayUrl && !scheme) {
    // Refuse to poison the runner's LLM endpoint with a schemeless URL.
    return { skip: "schemeless" };
  }
  if (llmKey && PLACEHOLDER_KEYS.has(llmKey)) {
    return { skip: "placeholder" };
  }
  return { skip: "missing" };
}

/** Build the Tableau credential payload for CES-based runners (byollm.json). */
export function buildTableauCredentials(config: {
  ces_url?: string;
  tableau_site?: string;
  tableau_pat_name?: string;
  tableau_pat_value?: string;
}): TableauCredentials | null {
  const cesUrl = config.ces_url;
  if (!cesUrl) return null;
  const server = runnerBaseUrl(cesUrl);
  const payload: TableauCredentials = { server };
  if (config.tableau_site) payload.site = config.tableau_site;
  if (config.tableau_pat_name) payload.pat_name = config.tableau_pat_name;
  if (config.tableau_pat_value) payload.pat_value = config.tableau_pat_value;
  return payload;
}

// ---------------------------------------------------------------------------
// Local `./config` file loader — used by the live smoke only.
// ---------------------------------------------------------------------------

export interface SmokeConfig {
  serverUrl: string;
  site: string;
  patName: string;
  patSecret: string;
}

const CONFIG_KEY_ALIASES: Record<string, keyof SmokeConfig> = {
  "tableau server url": "serverUrl",
  "server url": "serverUrl",
  "site content url": "site",
  "site": "site",
  "pat name": "patName",
  "pat secret": "patSecret",
};

/**
 * Parse the local `./config` file (a `Key: Value` per-line format) into a
 * {@link SmokeConfig}. The caller must treat `patSecret` as in-memory-only —
 * never log or persist it. This function itself never logs.
 *
 * `raw` is passed in (read by the caller) so this stays pure/testable and the
 * parser can be exercised without touching the real secret file.
 */
export function parseSmokeConfig(raw: string): SmokeConfig {
  const out: Partial<SmokeConfig> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const field = CONFIG_KEY_ALIASES[key];
    if (field && value) out[field] = value;
  }
  const missing = (["serverUrl", "site", "patName", "patSecret"] as const).filter(
    (k) => !out[k],
  );
  if (missing.length) {
    throw new Error(`config file missing required field(s): ${missing.join(", ")}`);
  }
  return out as SmokeConfig;
}

/** A redaction-safe view of a {@link SmokeConfig} for logging. */
export function redactSmokeConfig(cfg: SmokeConfig): Record<string, unknown> {
  return {
    serverUrl: cfg.serverUrl,
    site: cfg.site,
    patName: cfg.patName,
    patSecret: maskValue(cfg.patSecret),
  };
}
