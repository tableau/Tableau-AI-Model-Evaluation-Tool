/**
 * `tableau-ai-eval` CLI entrypoint and the
 * `bun build --compile` binary entrypoint.
 *
 * Usage:
 *   tableau-ai-eval serve [--host 127.0.0.1] [--port 8000] [--debug] [--allow-self-signed]
 *   tableau-ai-eval trust <server-url> [--out <path>]
 *   tableau-ai-eval rescore <run id…> | --all
 *   tableau-ai-eval version
 *
 * `serve` binds 127.0.0.1 by default — the tool is a localhost admin tool;
 * exposing it on a network interface is an explicit opt-in. It starts the
 * Bun.serve app (createApp) together with the in-process worker queue (started
 * inside createApp via routes.init()).
 *
 * `--allow-self-signed` (or env TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED=1) does NOT itself
 * change TLS behavior; it is a UI capability signal surfaced via
 * `GET /nlq-eval/settings/ui` so the frontend reveals the Verify-TLS toggle +
 * CA-bundle field.
 *
 * `trust` captures a server's TLS certificate chain and writes it to a PEM CA
 * bundle (default `~/.tableau-ai-eval/ca.pem`), which tlsOptions() auto-detects so a
 * private-CA server can be trusted WITHOUT disabling verification.
 *
 * `rescore` recomputes the tool's chart metrics for stored runs from the chart
 * definitions they stored, without calling the server.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { createApp, resolveDbPath, VERSION } from "./app.ts";
import { rescoreCommand } from "./rescore.ts";
import { startServer } from "./server.ts";
import { captureCertBundle, parseHostPort, prepareBundledContent, resolveOutPath, resolveCaBundlePath } from "@tableau-ai-eval/core";

interface ServeArgs {
  host: string;
  port: number;
  debug: boolean;
  allowSelfSigned: boolean;
}

function parseServeArgs(argv: string[]): ServeArgs {
  const args: ServeArgs = {
    host: process.env.TABLEAU_AI_EVAL_BIND || "127.0.0.1",
    port: Number(process.env.TABLEAU_AI_EVAL_PORT || "8000"),
    debug: false,
    allowSelfSigned:
      process.env.TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED === "1" ||
      process.env.TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED === "true",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") args.host = argv[++i] ?? args.host;
    else if (a === "--port") args.port = Number(argv[++i] ?? args.port);
    else if (a.startsWith("--host=")) args.host = a.slice("--host=".length);
    else if (a.startsWith("--port=")) args.port = Number(a.slice("--port=".length));
    else if (a === "--debug") args.debug = true;
    else if (a === "--allow-self-signed") args.allowSelfSigned = true;
  }
  return args;
}

function serve(argv: string[]): number {
  const args = parseServeArgs(argv);
  // Keep one source of truth for defaults: mirror the CLI values into env so
  // createApp's env-driven resolution agrees with the CLI.
  process.env.TABLEAU_AI_EVAL_BIND = args.host;
  process.env.TABLEAU_AI_EVAL_PORT = String(args.port);
  if (args.debug) process.env.TABLEAU_AI_EVAL_DEBUG = "1";
  // Surface the UI capability flag via env so createApp/routes expose it on
  // GET /nlq-eval/settings/ui (does not otherwise alter devMode or TLS).
  if (args.allowSelfSigned) process.env.TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED = "1";

  const app = createApp();
  // startServer builds the Bun.serve `routes` (API delegation + embedded/SPA
  // UI) + fetch fallback and binds the port; see src/server.ts. It resolves the
  // (possibly embedded) frontend bundle asynchronously, so serve() returns a
  // promise-driven flow but the process stays alive on the bound server.
  // `bun dev` sets TABLEAU_AI_EVAL_DEV_UI_URL so the UI is only ever served by Vite.
  const devUiUrl = process.env.TABLEAU_AI_EVAL_DEV_UI_URL || undefined;
  void startServer(app, { hostname: args.host, port: args.port, devUiUrl }).then(
    (server) => {
      process.stdout.write(
        `Tableau AI Model Evaluation Tool ${VERSION} listening on http://${server.hostname}:${server.port}\n`,
      );
      if (devUiUrl) process.stdout.write(`UI requests redirect to the dev server at ${devUiUrl}.\n`);
      // TLS trust. Bun's fetch verifies against this computer's certificate
      // store by default; a bundle from TABLEAU_AI_EVAL_CA_BUNDLE or
      // ~/.tableau-ai-eval/ca.pem (written by `tableau-ai-eval trust`) is trusted
      // in addition. Only that case is worth a line: the default needs no
      // action, and a line about it read as a warning (bug bash 2026-10-23).
      const caBundle = resolveCaBundlePath();
      if (caBundle) {
        process.stdout.write(`Also trusting the certificate bundle at ${caBundle}.\n`);
      }
      const shutdown = () => {
        try {
          server.stop(true);
        } catch {}
        try {
          app.db.close();
        } catch {}
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    },
  );
  return 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const command = argv[0];
  if (command === "serve") {
    return serve(argv.slice(1));
  }
  if (command === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (command === "rescore") {
    return rescore(argv.slice(1));
  }
  process.stdout.write(
    "tableau-ai-eval — Tableau AI Model Evaluation Tool\n\n" +
      "Usage:\n" +
      "  tableau-ai-eval serve [--host 127.0.0.1] [--port 8000] [--debug] [--allow-self-signed]\n" +
      "  tableau-ai-eval trust <server-url> [--out <path>]\n" +
      "  tableau-ai-eval rescore <run id…> | --all   score finished runs again with the current chart metrics (no server calls)\n" +
      "  tableau-ai-eval version\n",
  );
  return command === undefined ? 2 : 2;
}

/** `tableau-ai-eval rescore`: open the results store (TABLEAU_AI_EVAL_DATA_DIR) and rescore. */
function rescore(argv: string[]): number {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    process.stdout.write(`No results store at ${dbPath}; nothing to score.\n`);
    return 2;
  }
  const db = new AiEvalDb(dbPath);
  try {
    db.initDb();
    return rescoreCommand(db, argv);
  } finally {
    db.close();
  }
}

interface TrustArgs {
  target?: string;
  out?: string;
}

function parseTrustArgs(argv: string[]): TrustArgs {
  const args: TrustArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (!a.startsWith("-") && args.target === undefined) args.target = a;
  }
  return args;
}

/**
 * `tableau-ai-eval trust <server-url> [--out <path>]` — capture the server's TLS cert
 * chain and write it as a PEM CA bundle. Returns a process exit code.
 */
export async function trust(argv: string[]): Promise<number> {
  const args = parseTrustArgs(argv);
  if (!args.target) {
    process.stderr.write(
      "usage: tableau-ai-eval trust <server-url> [--out <path>]\n",
    );
    return 2;
  }
  const { hostname, port } = parseHostPort(args.target);
  const outPath = resolveOutPath(args.out);

  process.stdout.write(`Connecting to ${hostname}:${port} to capture its certificate…\n`);
  const { pem, method, count } = await captureCertBundle(hostname, port);
  if (!pem) {
    process.stderr.write(
      `Could not capture a certificate from ${hostname}:${port}. ` +
        "Is the host reachable and serving TLS? " +
        "(tried Bun's native TLS API and an openssl s_client fallback)\n",
    );
    return 1;
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, pem, { mode: 0o600 });

  process.stdout.write(
    `Wrote certificate bundle to ${outPath} (${count} cert${count === 1 ? "" : "s"}, via ${method}).\n`,
  );
  if (count === 1) {
    // A lone leaf is only a usable trust anchor if the server cert is
    // self-signed. Servers behind a private/enterprise CA present a leaf
    // signed by an intermediate that isn't captured here — verification
    // against a leaf-only bundle then fails.
    process.stderr.write(
      "Warning: only the server's leaf certificate was captured. If the " +
        "server is signed by a private/enterprise CA (not self-signed), this " +
        "bundle will NOT validate the chain. Obtain the issuing CA's " +
        "certificate(s) and point TABLEAU_AI_EVAL_CA_BUNDLE at them instead, or use " +
        "`tableau-ai-eval serve --allow-self-signed` and turn Verify TLS off.\n",
    );
  }
  process.stdout.write(
    `Next: set TABLEAU_AI_EVAL_CA_BUNDLE=${outPath} — or leave it, it is auto-detected at ~/.tableau-ai-eval/ca.pem.\n`,
  );
  return 0;
}

// Run when invoked directly (dev `bun run src/cli.ts` and compiled binary).
// The compiled binary first mounts its embedded test content (a no-op in dev,
// which reads the checkout's plain files) so the suite resolvers find it.
if (import.meta.main) {
  const command = process.argv[2];
  const contentReady =
    command === "serve" || command === "rescore"
      ? prepareBundledContent().catch((err) => {
          process.stderr.write(`Could not open the bundled test suites: ${err}\n`);
          return null;
        })
      : Promise.resolve(null);
  if (command === "trust") {
    trust(process.argv.slice(3)).then((code) => process.exit(code));
  } else {
    void contentReady.then(() => {
      const code = main();
      // `serve` returns 0 but keeps the process alive via Bun.serve; only exit for
      // the non-serving commands.
      if (command !== "serve") process.exit(code);
    });
  }
}
