/**
 * LIVE smoke test — attempts a REAL Tableau signin using
 * `TableauSession`, reading server/site/PAT from the local `./config` file at
 * runtime (in-memory only). This is BEST-EFFORT: the configured target may
 * be unreachable from this machine.
 *
 * Guarantees:
 *   - NEVER prints the PAT secret or the session token.
 *   - Reads `./config` programmatically; does not copy or persist it.
 *   - Verifies TLS and uses the configured CA bundle when present.
 *   - If DNS/connection fails, reports "unreachable" clearly.
 *   - If signin 404s on api version 3.22, tries a couple nearby versions and
 *     reports which one worked.
 *
 * Run: `$HOME/.bun/bin/bun run scripts/smoke_tableau.ts`
 */

import { TableauSession, TableauAuthError } from "@tableau-ai-eval/core";
import { parseSmokeConfig, redactSmokeConfig, resolveCaBundlePath } from "@tableau-ai-eval/core";

const CONFIG_PATH = new URL("../config", import.meta.url);
const API_VERSIONS = ["3.22", "3.21", "3.24", "3.25"];

function line(msg: string) {
  console.log(msg);
}

function isUnreachable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("getaddrinfo") ||
    msg.includes("unable to connect") ||
    msg.includes("connectionrefused") ||
    msg.includes("was aborted") ||
    msg.includes("timeout") ||
    msg.includes("failed to fetch") ||
    msg.includes("connection closed")
  );
}

async function main() {
  line("=== Tableau LIVE signin smoke (best-effort) ===");

  let raw: string;
  try {
    raw = await Bun.file(CONFIG_PATH).text();
  } catch (e) {
    line(`RESULT: could not read ./config (${e instanceof Error ? e.message : e}).`);
    line("Nothing to smoke against; rely on the offline unit tests.");
    return;
  }

  let cfg: ReturnType<typeof parseSmokeConfig>;
  try {
    cfg = parseSmokeConfig(raw);
  } catch (e) {
    line(`RESULT: ./config could not be parsed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  // Only ever log the redacted view — never the secret.
  line(`config (redacted): ${JSON.stringify(redactSmokeConfig(cfg))}`);
  line("TLS verification: ON");

  let anyReachable = false;

  for (const apiVersion of API_VERSIONS) {
    const session = new TableauSession({
      serverUrl: cfg.serverUrl,
      patName: cfg.patName,
      patSecret: cfg.patSecret,
      siteContentUrl: cfg.site,
      apiVersion,
      verify: true,
      caBundlePath: resolveCaBundlePath(),
    });

    line(`\n-- trying api version ${apiVersion} --`);
    try {
      const token = await session.getToken();
      const siteId = await session.siteId();
      anyReachable = true;
      line(`  signin: OK`);
      line(`  api version used: ${apiVersion}`);
      line(`  token received: ${token ? "yes (not printed)" : "no"}`);
      line(`  site LUID present: ${siteId ? `yes (${siteId})` : "no"}`);
      line(`\nRESULT: SUCCESS — reachable, signin OK on api ${apiVersion}, site LUID ${siteId ? "present" : "absent"}.`);
      return;
    } catch (err) {
      if (err instanceof TableauAuthError) {
        anyReachable = true;
        line(`  signin: REFUSED (auth error) — PAT invalid/expired or wrong site.`);
        line(`\nRESULT: REACHABLE but signin refused (PAT/site problem). No secrets printed.`);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const is404 = msg.includes("returned 404");
      if (is404) {
        line(`  signin: 404 on api ${apiVersion} — trying next version.`);
        anyReachable = true;
        continue;
      }
      if (isUnreachable(err)) {
        line(`  connection: UNREACHABLE (${msg})`);
        // No point trying other API versions if the host itself is down.
        break;
      }
      line(`  signin: ERROR (${msg}) — trying next version.`);
      anyReachable = true;
    }
  }

  if (!anyReachable) {
    line(`\nRESULT: UNREACHABLE — the Tableau Server at ${cfg.serverUrl} could not be contacted from this host.`);
  } else {
    line(`\nRESULT: reachable but no api version produced a successful signin (see per-version notes above). No secrets printed.`);
  }
}

await main();
