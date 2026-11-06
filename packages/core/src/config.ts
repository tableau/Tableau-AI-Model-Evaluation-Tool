/**
 * Local secrets/config accessor (LEX — dev + smoke).
 *
 * Secrets live in a git-ignored `.env` (see `.env.example` for the schema),
 * which Bun auto-loads into `process.env`. This module is the single typed
 * entrypoint for reading them, so callers never hand-parse env vars and never
 * need to print raw values. Use `describeConfig()` for safe, redacted logging.
 *
 * Never log `patSecret` / `apiKey` directly — use `redact()` / `describeConfig()`.
 */

export interface TableauConfig {
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
  patSecret: string;
}

export interface JudgeConfig {
  provider: string;
  model: string;
  apiKey: string;
}

export interface AiEvalSecrets {
  tableau?: TableauConfig;
  judge?: JudgeConfig;
}

/** Mask a secret for logs: keep the last 4 chars, redact the rest. */
export function redact(value: string | undefined): string {
  if (!value) return "(unset)";
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function req(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Read Tableau creds from the environment; returns undefined if the required
 * fields aren't all present (so callers can skip Tableau-dependent paths).
 */
export function loadTableauConfig(
  env: NodeJS.ProcessEnv = process.env,
): TableauConfig | undefined {
  const serverUrl = req(env, "TABLEAU_SERVER_URL");
  const patName = req(env, "TABLEAU_PAT_NAME");
  const patSecret = req(env, "TABLEAU_PAT_SECRET");
  if (!serverUrl || !patName || !patSecret) return undefined;
  return {
    serverUrl,
    siteContentUrl: req(env, "TABLEAU_SITE_CONTENT_URL") ?? "",
    patName,
    patSecret,
  };
}

/**
 * Read the BYOK judge config from the environment. Picks the provider-specific
 * API key (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY). Returns
 * undefined when provider or key is missing.
 */
export function loadJudgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): JudgeConfig | undefined {
  const provider = (req(env, "JUDGE_PROVIDER") ?? "openai").toLowerCase();
  const keyVar =
    provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : provider === "gemini"
        ? "GEMINI_API_KEY"
        : "OPENAI_API_KEY";
  const apiKey = req(env, keyVar);
  if (!apiKey) return undefined;
  return {
    provider,
    model: req(env, "JUDGE_MODEL") ?? "",
    apiKey,
  };
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): AiEvalSecrets {
  return { tableau: loadTableauConfig(env), judge: loadJudgeConfig(env) };
}

/** A safe, secret-free summary for logging / debugging. */
export function describeConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const t = loadTableauConfig(env);
  const j = loadJudgeConfig(env);
  return {
    tableau: t
      ? {
          serverUrl: t.serverUrl,
          siteContentUrl: t.siteContentUrl,
          patName: t.patName,
          patSecret: redact(t.patSecret),
        }
      : "(not configured)",
    judge: j
      ? { provider: j.provider, model: j.model, apiKey: redact(j.apiKey) }
      : "(not configured)",
  };
}
