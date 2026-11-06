/**
 * TLS option builder for Tableau-bound `fetch` calls (backend TLS ergonomics).
 *
 * Bun's `fetch` accepts a per-request `tls` object (see
 * `BunFetchRequestInitTLS`). We centralize the three self-signed / internal-CA
 * ergonomics here so session.ts and preflight.ts don't each re-derive the
 * shape, and so env-reading stays at the edge (callers pass `caBundlePath`;
 * only `resolveCaBundlePath()` touches env / the filesystem default).
 *
 * ## The three branches (`tlsOptions`)
 *   1. verify === false                     → { rejectUnauthorized: false }
 *      Disable chain verification entirely (the historic self-signed escape
 *      hatch). A CA bundle is irrelevant here, so it is ignored.
 *   2. verify === true  + caBundlePath set  → { ca: Bun.file(caBundlePath) }
 *      Keep verification ON but trust a private/self-signed CA. This is the
 *      preferred path: the connection is still authenticated, we just extend
 *      the trust store with an operator-supplied PEM bundle.
 *   3. verify === true  + no caBundlePath   → {}
 *      Default system trust (Mozilla CA set).
 *
 * The returned object is spread into a `RequestInit` as `{ tls: <this> }` OR
 * merged directly — `tlsInit()` wraps it so callers keep the `...tlsInit(...)`
 * spread ergonomics they had with the old bare helper.
 *
 * ## CA bundle discovery (`resolveCaBundlePath`)
 * Precedence: explicit env `TABLEAU_AI_EVAL_CA_BUNDLE` → auto-detected `~/.tableau-ai-eval/ca.pem`
 * (written by `tableau-ai-eval trust`, see cli.ts) → none. Kept as a pure function of
 * `(env, homeDir, fileExists)` so it is unit-testable without touching disk.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Bun `fetch` `tls` option shape we produce. */
export interface BunTlsOption {
  rejectUnauthorized?: boolean;
  ca?: unknown; // Bun.BunFile | string | ... — kept loose for injectable tests
}

export interface TlsOptionsInput {
  /** TLS chain verification; false disables it (self-signed/internal certs). */
  verify: boolean;
  /** PEM CA bundle path to trust when verify is true. */
  caBundlePath?: string;
  /**
   * Injectable file-open (tests). Defaults to Bun.file. Only called for the
   * verify=true + caBundlePath branch, so tests never need a real PEM.
   */
  openFile?: (path: string) => unknown;
}

/**
 * Build the Bun `fetch` `tls` object for a request. See file header for the
 * three-branch semantics. Returns `{}` for the default-system-trust case.
 */
export function tlsOptions(input: TlsOptionsInput): BunTlsOption {
  const { verify, caBundlePath } = input;
  if (!verify) {
    // Disabling verification entirely — a CA bundle would be moot.
    return { rejectUnauthorized: false };
  }
  const trimmed = caBundlePath?.trim();
  if (trimmed) {
    const open = input.openFile ?? ((p: string) => Bun.file(p));
    return { ca: open(trimmed) };
  }
  return {};
}

/**
 * Wrap `tlsOptions()` into a `RequestInit` fragment so callers keep the
 * `{ ...tlsInit(...) }` spread ergonomics. Returns `{}` (no `tls` key) for the
 * default-system-trust case so we never attach an empty `tls` object.
 */
export function tlsInit(input: TlsOptionsInput): { tls?: BunTlsOption } {
  const tls = tlsOptions(input);
  if (Object.keys(tls).length === 0) return {};
  return { tls };
}

/**
 * Resolve the effective CA bundle path from env + auto-detection.
 * Pure over its inputs for testability.
 *
 *   1. `TABLEAU_AI_EVAL_CA_BUNDLE` (explicit) — used verbatim (leading `~` expanded).
 *   2. `~/.tableau-ai-eval/ca.pem` — auto-detected when it exists on disk.
 *   3. undefined — default system trust.
 */
export function resolveCaBundlePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fileExists: (p: string) => boolean = existsSync,
): string | undefined {
  const explicit = env.TABLEAU_AI_EVAL_CA_BUNDLE;
  if (explicit && explicit.trim()) {
    return explicit.trim().replace(/^~(?=$|[\\/])/, home);
  }
  const autodetect = join(home, ".tableau-ai-eval", "ca.pem");
  if (fileExists(autodetect)) return autodetect;
  return undefined;
}
