/**
 * Build a {@link TableauSession} and a stable connection-cache key from a
 * merged `RunConfig`, per-run and with no import-time credential coupling.
 *
 * This centralizes the near-identical `buildSession` / `connectionKey` helpers
 * that the nlq / prep / cabu harness runners each had (they differed only in a
 * couple of injectable knobs), so the config-key mapping
 * (`tableau_server` / `tableau_pat_name|pat_name` / `tableau_pat_value|pat_value`
 * / `tableau_site` / `verify_tls` / `ca_bundle_path`) lives in exactly one place.
 */

import type { RunConfig } from "../adapters/contract.ts";
import { TableauSession, type FetchLike } from "./session.ts";
import { resolveCaBundlePath } from "./tls.ts";

export interface SessionFromConfigOptions {
  /** Injectable fetch (tests / bridges). Passed through to TableauSession. */
  fetchImpl?: FetchLike;
  /**
   * When true, fall back to `resolveCaBundlePath()` (env `TABLEAU_AI_EVAL_CA_BUNDLE` /
   * `~/.tableau-ai-eval/ca.pem`) if `config.ca_bundle_path` is unset. The cabu runner
   * uses this; nlq/prep rely on the config value already threaded from the edge.
   */
  caBundleFallback?: boolean;
  /**
   * Explicit TLS verify override. Defaults to `config.verify_tls ?? true`. The
   * cabu runner passes its own `verifyTls(config)` (which also honors
   * `cabu_verify_tls` and a localhost default), so the caller supplies it here.
   */
  verify?: boolean;
  /** Dead-PAT hook (the orchestrator uses this; runners typically omit it). */
  onAuthFailure?: (reason: string) => void;
}

/**
 * Build a {@link TableauSession} from a merged `RunConfig`, or `null` when the
 * PAT triplet (server + pat name + pat value) is incomplete (the caller then
 * falls back to another auth path, e.g. cabu username/password login).
 */
export function sessionFromRunConfig(
  config: RunConfig,
  opts: SessionFromConfigOptions = {},
): TableauSession | null {
  const server = String(config.tableau_server ?? "");
  const patName = String(config.tableau_pat_name ?? config.pat_name ?? "");
  const patValue = String(config.tableau_pat_value ?? config.pat_value ?? "");
  if (!server || !patName || !patValue) return null;

  const caFromConfig = config.ca_bundle_path as string | undefined;
  const caBundlePath = opts.caBundleFallback
    ? (caFromConfig ?? resolveCaBundlePath())
    : caFromConfig;

  return new TableauSession({
    serverUrl: server, // TableauSession strips trailing slashes itself.
    patName,
    patSecret: patValue,
    siteContentUrl: String(config.tableau_site ?? ""),
    verify: opts.verify ?? ((config.verify_tls as boolean) ?? true),
    caBundlePath,
    onAuthFailure: opts.onAuthFailure,
    // TableauSession's FetchLike is `typeof fetch`; callers pass either the
    // global fetch or a test fake, both assignable.
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * Stable key for a session cache — server + site + PAT NAME (never the secret)
 * + verify flag. `leadingKeys` prepends extra `RunConfig` fields (the prep
 * runner keys on `gateway_url` as well, so it passes `["gateway_url"]`).
 */
export function connectionKey(
  config: RunConfig,
  leadingKeys: string[] = [],
): string {
  const parts = [
    ...leadingKeys.map((k) => String(config[k] ?? "")),
    String(config.tableau_server ?? ""),
    String(config.tableau_site ?? ""),
    String(config.tableau_pat_name ?? config.pat_name ?? ""),
    String(config.verify_tls ?? true),
  ];
  return parts.join("|");
}
