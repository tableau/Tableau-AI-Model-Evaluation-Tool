/**
 * Native TypeScript CABU suite loader + client factory — the real wiring that
 * `src/adapters/cabu/adapter.ts` leaves injectable (`CabuSuiteLoader` /
 * `CabuClientFactory`). Supplies suite discovery/loading
 * (`_resolve_suite_file` + `_load_cases`), base-URL/TLS derivation
 * (`_base_urls` + `_verify_tls`), and per-run auth (`_make_session` +
 * PAT-token/site injection or the client's own username/password signin).
 *
 * ## Why this lives here (not in adapter.ts)
 *
 * `adapter.ts` is the pure runner-adapter contract wiring (build/parse only,
 * no IO). It keeps the loader/factory injectable so tests can drive the whole
 * loader→client→row→score path with an injected fetch and NO live calls. This
 * module supplies the real, path-explicit, per-run implementations and is what
 * the adapter self-registers with. Mirrors how `nlq_runner.ts` is the real
 * `HarnessRunner` behind the injectable seam in `nlq.ts`.
 *
 * ## Decoupling (same principle as nlq_runner / the plan)
 *
 * NO import-time credential coupling and NO CWD coupling:
 *   - the suite path is resolved from the merged `RunConfig` at load time
 *     (`test_path`/`cabu_suites_root`/`$TABLEAU_AI_EVAL_CABU_SUITES`), absolute or
 *     injectable — never CWD-relative;
 *   - the Tableau auth (server / PAT / site / verify / CA bundle) is read from
 *     `config` at factory time and built into a per-run {@link TableauSession},
 *     exactly like `nlq_runner.buildSession`. The client factory is `async`
 *     because minting the PAT token is a network round-trip.
 *
 * ## Dashboard Q&A suite format
 *
 * A single YAML file: `{common: {...}, tests: [{input: {...}, tags: [...]}]}`.
 * The YAML uses anchors/merge-keys so the `common` block is already folded into
 * each `input` (each `input` is self-contained after parse). Each `input`
 * carries the utterance + the workbook/datasource LUIDs (shipped as
 * `PLACEHOLDER` for portability; the run config overrides them) + the expected
 * answer/output-types the adapter scores against. Bun has no stdlib YAML, so
 * this uses `js-yaml` (pure JS, `bun build --compile`-safe) — the same parser
 * the frontend uses.
 *
 * ## Live-verification caveat
 *
 * A real CABU run needs a CABU-enabled server, published workbook/datasource
 * LUIDs, and a suite YAML file. Tests run in an
 * offline environment. The loader/factory therefore CANNOT be live-verified
 * here; the offline tests exercise the full loader→client→row→score path with
 * canned phase responses and an injected fetch, which proves the wiring.
 */

import { basename, dirname, extname, isAbsolute, join } from "node:path";

import type { RunConfig } from "@tableau-ai-eval/core";
import { contentIsDir, contentIsFile, contentReadText } from "@tableau-ai-eval/core";
import type { CabuCase, CabuClientFactory, CabuSuiteLoader } from "../adapters/cabu/adapter.ts";
import { TabCabuServiceClient, type FetchLike } from "../adapters/cabu/client.ts";
import { TableauSession } from "@tableau-ai-eval/core";
import { resolveCaBundlePath } from "@tableau-ai-eval/core";
import { sessionFromRunConfig, sharedSession } from "@tableau-ai-eval/core";
import { load as yamlLoad } from "js-yaml";
import { bundledDir } from "../public_suites.ts";

const DEFAULT_SUITE = "cabu_superstore";

// ---------------------------------------------------------------------------
// Suite discovery / loading (mirrors _resolve_suite_file + _load_cases)
// ---------------------------------------------------------------------------

const isDir = contentIsDir;
const isFile = contentIsFile;

/**
 * Locate custom dashboard Q&A suites using config `cabu_suites_root` or
 * `$TABLEAU_AI_EVAL_CABU_SUITES`, without machine-specific fallbacks.
 */
function cabuSuitesDir(config: RunConfig, env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    typeof config.cabu_suites_root === "string" ? config.cabu_suites_root : null,
    env.TABLEAU_AI_EVAL_CABU_SUITES ?? null,
  ];
  for (const c of candidates) {
    if (c && isDir(c)) return c;
  }
  return null;
}

/** Where the bundled Questions about a dashboard suite lives under `public-suites/`. */
export const BUNDLED_SUBDIR = join("dashboard-qa", "cases");

/** The dashboard Q&A suites that ship with the tool, or null. */
export function bundledSuitesDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return bundledDir(BUNDLED_SUBDIR, env);
}

/**
 * Resolve the suite YAML file from config. Mirrors `_resolve_suite_file`:
 *   - `test_path`/`test_cases_dir` naming a `.yml`/`.yaml` file wins outright;
 *   - otherwise treat the value as a suite name and look it up (name, name.yml,
 *     name.yaml) under an explicitly named suites directory first, then the
 *     suites that ship with the tool (`public-suites/dashboard-qa/cases`).
 * Absolute/injectable — never CWD-relative.
 */
export function resolveSuiteFile(
  config: RunConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    (typeof config.test_path === "string" && config.test_path) ||
    (typeof config.test_cases_dir === "string" && config.test_cases_dir) ||
    DEFAULT_SUITE;

  const lower = raw.toLowerCase();
  if ((lower.endsWith(".yml") || lower.endsWith(".yaml")) && isFile(raw)) {
    return raw;
  }

  const dirs = [cabuSuitesDir(config, env), bundledSuitesDir(env)].filter(
    (d): d is string => d !== null,
  );
  if (dirs.length === 0) {
    throw new Error(
      "Dashboard Q&A suites not found: the tool's public-suites/dashboard-qa " +
        "folder is missing. Set config 'cabu_suites_root' or " +
        "$TABLEAU_AI_EVAL_CABU_SUITES to a directory of suite files",
    );
  }
  for (const suitesDir of dirs) {
    for (const name of [raw, `${raw}.yml`, `${raw}.yaml`]) {
      const candidate = isAbsolute(name) ? name : join(suitesDir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  throw new Error(`CABU suite not found: ${JSON.stringify(raw)} (looked in ${dirs.join(", ")})`);
}

/**
 * Parse dashboard Q&A suite YAML text into per-case structs. Includes
 * `_load_cases`, including: dropping cases with no non-blank utterance, the
 * `utteranceId`-or-`case.N` id derivation, and de-duplicating collided ids with
 * a `__dupN` suffix.
 *
 * Pure over the raw text so it is trivially testable without touching disk.
 */
export function parseSuiteYaml(text: string, sourceLabel = "<suite>"): CabuCase[] {
  const data = yamlLoad(text) as unknown;
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Array.isArray((data as Record<string, unknown>).tests)
  ) {
    throw new Error(`${sourceLabel} is not a dashboard Q&A suite YAML (no 'tests' list)`);
  }
  const tests = (data as Record<string, unknown>).tests as unknown[];
  const cases: CabuCase[] = [];
  const seen = new Map<string, number>();

  tests.forEach((test, i) => {
    if (test === null || typeof test !== "object" || Array.isArray(test)) return;
    const t = test as Record<string, unknown>;
    const inp =
      t.input && typeof t.input === "object" && !Array.isArray(t.input)
        ? (t.input as Record<string, unknown>)
        : {};
    const utterance = inp.utterance;
    if (typeof utterance !== "string" || !utterance.trim()) {
      // Skip cases with no runnable utterance.
      return;
    }
    const baseId = String(inp.utteranceId ?? `case.${i + 1}`);
    const n = seen.get(baseId) ?? 0;
    seen.set(baseId, n + 1);
    const caseId = n === 0 ? baseId : `${baseId}__dup${n}`;

    const tags = Array.isArray(t.tags)
      ? (t.tags as unknown[])
      : Array.isArray(inp.tags)
        ? (inp.tags as unknown[])
        : [];

    cases.push({ caseId, input: inp, tags });
  });

  return cases;
}

/**
 * The real {@link CabuSuiteLoader}: resolve the suite file from config, read
 * it, and parse it. `readFile`/`env` are injectable so the loader is unit
 * testable without a real suite file on disk.
 */
/**
 * How each expected answer was computed, for a public suite: the shipped
 * `ground-truth/<suite>.json` beside the cases holds, per question, the data
 * source, the SQL run against its extract and the value it gave. Attached to
 * the case so the results page can show it (bug bash 2026-10-23: "add the
 * data behind the expected answer"). Custom suites may omit this file.
 */
export function groundTruthFor(suiteFile: string, isFile = contentIsFile, read = contentReadText): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const path = join(dirname(suiteFile), "..", "ground-truth", `${basename(suiteFile, extname(suiteFile))}.json`);
  if (!isFile(path)) return out;
  try {
    const data = JSON.parse(read(path)) as { cases?: unknown };
    for (const raw of Array.isArray(data.cases) ? data.cases : []) {
      const c = raw as Record<string, unknown>;
      if (typeof c.id !== "string") continue;
      const entry: Record<string, unknown> = {};
      for (const key of ["datasource", "sql", "expect", "kind"]) if (c[key] !== undefined) entry[key] = c[key];
      out.set(c.id, entry);
    }
  } catch {
    /* a malformed file costs the disclosure, not the run */
  }
  return out;
}

function withGroundTruth(cases: CabuCase[], suiteFile: string): CabuCase[] {
  const truths = groundTruthFor(suiteFile);
  if (!truths.size) return cases;
  return cases.map(c => (truths.has(c.caseId) ? { ...c, groundTruth: truths.get(c.caseId) } : c));
}

export function createCabuSuiteLoader(opts: {
  readFile?: (path: string) => string;
  env?: NodeJS.ProcessEnv;
} = {}): CabuSuiteLoader {
  const readFile = opts.readFile ?? contentReadText;
  const env = opts.env ?? process.env;
  return (config: RunConfig): CabuCase[] => {
    if (Array.isArray(config._suite_parts)) {
      return config._suite_parts.flatMap((raw) => {
        const part = raw as { id: string; key: string; label: string; path: string };
        return withGroundTruth(parseSuiteYaml(readFile(part.path), part.path), part.path).map(c => ({
          ...c,
          caseId: `${part.key}.${c.caseId}`,
          input: { ...c.input, _part: part.id, _part_label: part.label },
        }));
      });
    }
    const suiteFile = resolveSuiteFile(config, env);
    const text = readFile(suiteFile);
    return withGroundTruth(parseSuiteYaml(text, suiteFile), suiteFile);
  };
}

// ---------------------------------------------------------------------------
// Base URLs + TLS (mirrors _base_urls + _verify_tls)
// ---------------------------------------------------------------------------

/**
 * (cabuBaseUrl, loginBaseUrl). The CABU base resolves `cabu_base_url` →
 * `ces_url` (dev servers where CES is not at <server>/content-exploration) →
 * derived from `tableau_server`. Mirrors `_base_urls`.
 */
export function baseUrls(config: RunConfig): { baseUrl: string; loginBaseUrl: string } {
  const server = String(config.tableau_server ?? "").replace(/\/+$/, "");
  let base =
    String(config.cabu_base_url ?? "").replace(/\/+$/, "") ||
    String(config.ces_url ?? "").replace(/\/+$/, "");
  if (!base) {
    if (!server) {
      throw new Error(
        "CABU adapter needs 'cabu_base_url' (…/content-exploration) or " +
          "'tableau_server' to derive it",
      );
    }
    base = `${server}/content-exploration`;
  }
  const loginBaseUrl = String(config.cabu_login_base_url ?? server ?? base).replace(/\/+$/, "");
  return { baseUrl: base, loginBaseUrl: loginBaseUrl || base };
}

/**
 * TLS verification: `cabu_verify_tls` overrides the shared `verify_tls`; if
 * neither is set, verify unless the CABU host is localhost/127.0.0.1. Mirrors
 * `_verify_tls`.
 */
export function verifyTls(config: RunConfig): boolean {
  let raw = config.cabu_verify_tls;
  if (raw === undefined || raw === null) raw = config.verify_tls;
  if (raw !== undefined && raw !== null) return Boolean(raw);
  let host: string | null = null;
  try {
    host = new URL(baseUrls(config).baseUrl).hostname;
  } catch {
    return true;
  }
  return host !== "localhost" && host !== "127.0.0.1";
}

// ---------------------------------------------------------------------------
// Auth (mirrors _make_session + the PAT-token/site injection seam)
// ---------------------------------------------------------------------------

/**
 * Build a PAT {@link TableauSession} when the PAT fields are present,
 * else null (the client's username/password signin is the fallback). Mirrors
 * `_make_session`. Per-run, no import-time credential coupling.
 */
export function buildSession(
  config: RunConfig,
  fetchImpl?: FetchLike,
): TableauSession | null {
  // cabu keeps its own verify policy (verifyTls also honors cabu_verify_tls +
  // a localhost default), uses the CA-bundle fallback (resolveCaBundlePath)
  // when the config doesn't carry ca_bundle_path, and threads the (leaner)
  // FetchLike through.
  return sessionFromRunConfig(config, {
    verify: verifyTls(config),
    caBundleFallback: true,
    fetchImpl: fetchImpl as unknown as typeof fetch | undefined,
  });
}

/**
 * The real {@link CabuClientFactory}: construct a shared
 * {@link TabCabuServiceClient} with a per-run auth built from config.
 *
 * Two auth paths, mirroring `CabuAdapter.execute`:
 *   - PAT path: build a {@link TableauSession} from server/PAT/site, mint the
 *     token, and inject `authToken` + `siteLuid` into the client (
 *     `child_client()` injection seam — the client skips its own login);
 *   - signin path: no PAT → require cabu_username/cabu_password/tableau_site and
 *     call the client's own `login()`.
 *
 * `fetchImpl` / `sessionFactory` / `uuidHex` are injectable so tests drive the
 * whole flow with a fake fetch and NO live calls.
 *
 * The orchestrator's shared session supplies per-conversation token leases and
 * coordinated 401 recovery in the adapter. Direct factory callers without a
 * registered run session receive a snapshot token only.
 */
export function createCabuClientFactory(opts: {
  fetchImpl?: FetchLike;
  sessionFactory?: (config: RunConfig) => TableauSession | null;
  uuidHex?: () => string;
} = {}): CabuClientFactory {
  const sessionFactory =
    opts.sessionFactory ?? ((config: RunConfig) => buildSession(config, opts.fetchImpl));

  return async (config: RunConfig): Promise<TabCabuServiceClient> => {
    const { baseUrl, loginBaseUrl } = baseUrls(config);
    const verify = verifyTls(config);
    const session = sharedSession(String(config.job_id || "")) ?? sessionFactory(config);

    const shared = new TabCabuServiceClient({
      baseUrl,
      loginBaseUrl,
      username: (config.cabu_username as string | undefined) ?? null,
      password: (config.cabu_password as string | undefined) ?? null,
      sitename: (config.tableau_site as string | undefined) ?? null,
      sslVerify: verify,
      // Trust a private/enterprise CA on the content-exploration client too
      // (same source as the PAT session). Without this, verify=true + a private
      // CA is rejected even after `tableau-ai-eval trust`.
      caBundlePath: (config.ca_bundle_path as string | undefined) ?? resolveCaBundlePath(),
      fetchImpl: opts.fetchImpl,
      uuidHex: opts.uuidHex,
    });

    if (session !== null) {
      // PAT path: inject the tool's session token + site LUID (
      // child_client() injection seam — the client then skips login()).
      shared.authToken = await session.getToken();
      shared.siteLuid = session.cachedSiteId;
    } else {
      if (!(shared.username && shared.password && shared.sitename)) {
        throw new Error(
          "CABU auth needs either tableau_server + tableau_pat_name/" +
            "tableau_pat_value (PAT path) or cabu_username + cabu_password + " +
            "tableau_site (signin path)",
        );
      }
      await shared.login();
    }
    return shared;
  };
}
