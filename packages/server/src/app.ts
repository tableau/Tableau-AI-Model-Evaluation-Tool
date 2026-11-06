/**
 * Bun.serve app factory.
 *
 * Single OS process: this web app plus the in-process sequential worker queue
 * (`src/worker/queue.ts`). All persistence is one SQLite file (`src/db`); there
 * is no Redis, no RQ, no separate worker process.
 *
 * Mounts:
 *   - GET /health                — SQLite reachability + worker liveness
 *   - the 20 NLQ-eval routes     — via `createNlqEvalApp` (src/routes/nlq_eval)
 *   - SPA / static fallback      — serves the React build from FRONTEND_DIR,
 *                                  else a documented placeholder page.
 *
 * ## Env config (TABLEAU_AI_EVAL_* contract):
 *   TABLEAU_AI_EVAL_BIND      bind host (default 127.0.0.1)
 *   TABLEAU_AI_EVAL_PORT      port (default 8000)
 *   TABLEAU_AI_EVAL_DEBUG     "1"/"true" enables debug logging
 *   TABLEAU_AI_EVAL_DATA_DIR  SQLite parent dir (default ~/.tableau-ai-eval under a compiled
 *                    binary, else ./data)
 *   TABLEAU_AI_EVAL_FRONTEND_DIR  React build dir (default: compiled -> <binary-dir>/frontend/build,
 *                    dev -> packages/frontend/build)
 *
 * ## Compiled-binary path resolution:
 * Under `bun build --compile` the source lives in a synthetic `$bunfs` root, so
 * `import.meta.url` is NOT a usable disk path. DATA_DIR/FRONTEND_DIR therefore
 * resolve against `dirname(process.execPath)` (the real on-disk location of the
 * binary + its sidecars) when compiled, and against the repo root in dev. The
 * frontend build dir may not exist yet — we serve a placeholder and
 * document it rather than 404.
 */

import { existsSync, statSync, mkdirSync, readFileSync } from "node:fs";
import * as pathMod from "node:path";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { SseState } from "@tableau-ai-eval/core";
import { JobQueue } from "./worker/queue.ts";
import { createNlqEvalApp, type NlqEvalApp, type RoutesDeps } from "./routes/nlq_eval.ts";
// Register the concrete eval adapters (nlq/prep/cabu) into the shared
// `@tableau-ai-eval/core` registry. `core` no longer self-imports them (no package
// cycle), so the server is responsible for pulling them in. The import has the
// synchronous side effect of populating the registry; the explicit call makes
// the server→evals dependency obvious at the composition root.
import { registerAdapters } from "@tableau-ai-eval/evals";
void registerAdapters();

export const VERSION = "0.1.0";

/** True when running from a `bun build --compile` binary. Uses Bun's official
 * flag (robust across OSes) and falls back to the synthetic-root markers for
 * non-Bun/edge runtimes. The marker form differs by platform: POSIX uses
 * `/$bunfs/`, Windows uses `B:/~BUN/` — so string-matching alone is unreliable. */
export function isCompiled(): boolean {
  const b = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun;
  if (b && typeof b.isStandaloneExecutable === "boolean") {
    return b.isStandaloneExecutable;
  }
  const u = import.meta.url;
  return u.includes("/$bunfs/") || u.includes("/~BUN/") || u.includes("B~");
}

/** The on-disk base for sidecars/assets: dirname(execPath) compiled, else repo root. */
export function bundleRoot(): string {
  if (isCompiled()) return dirname(process.execPath);
  // src/ -> repo root. fileURLToPath handles Windows drive-letter URLs correctly
  // (new URL(...).pathname yields a broken leading-slash path on Windows).
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Resolve the SQLite path (TABLEAU_AI_EVAL_DATA_DIR contract,). */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env.TABLEAU_AI_EVAL_DATA_DIR;
  if (envDir) return join(resolve(envDir.replace(/^~/, homedir())), "nlq_eval_results.db");
  if (isCompiled()) return join(homedir(), ".tableau-ai-eval", "nlq_eval_results.db");
  return join(bundleRoot(), "data", "nlq_eval_results.db");
}

/** Resolve the React build dir (TABLEAU_AI_EVAL_FRONTEND_DIR contract). */
export function resolveFrontendDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TABLEAU_AI_EVAL_FRONTEND_DIR;
  if (override) return resolve(override.replace(/^~/, homedir()));
  // Compiled binary: the frontend ships beside the executable.
  if (isCompiled()) return join(dirname(process.execPath), "frontend", "build");
  // Dev: bundleRoot() is `packages/server` (src/..), but the Vite build lives in
  // the sibling `packages/frontend/build`. Resolve it relative to bundleRoot so
  // `bun start` serves the real UI with no TABLEAU_AI_EVAL_FRONTEND_DIR needed.
  return join(bundleRoot(), "..", "frontend", "build");
}

/** Minimal path-module surface `isPathInside` needs (injectable for tests). */
interface PathLike {
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
}

/**
 * True when `child` is `root` or lives inside it — the path-traversal guard for
 * on-disk asset serving. Uses `path.relative` (separator-agnostic) rather than a
 * `child.startsWith(root + "/")` prefix check: on Windows `resolve()` yields `\`
 * separators, so a hard-coded `/` prefix check rejects EVERY legitimate asset and
 * falls through to serving index.html for `.js`/`.css` (see serveSpa). Both paths
 * must already be resolved/absolute. `p` is injectable so tests can drive both
 * `path.win32` and `path.posix` semantics on any host.
 */
export function isPathInside(root: string, child: string, p: PathLike = pathMod): boolean {
  if (child === root) return true;
  const rel = p.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
}

export const PLACEHOLDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Tableau AI Model Evaluation Tool</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
<h1>Tableau AI Model Evaluation Tool</h1>
<p>The backend is running. The frontend build was not found.</p>
<p>Set <code>TABLEAU_AI_EVAL_FRONTEND_DIR</code> to a built React app, or place it at
<code>&lt;binary-dir&gt;/frontend/build</code>. The API is available under
<code>/nlq-eval/*</code> and <code>/health</code>.</p>
</body></html>`;

/**
 * Content-Type by extension for on-disk asset serving. Bun.file already infers
 * a type for many extensions, but we pin the ones the Vite build emits so the
 * on-disk (dev/override) path matches the embedded-HTMLBundle path exactly.
 */
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function mimeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  return MIME_BY_EXT[path.slice(dot).toLowerCase()];
}

export interface AppOptions {
  /** Pre-built db (tests pass ":memory:" backed). Default: file at resolveDbPath(). */
  db?: AiEvalDb;
  sse?: SseState;
  queue?: JobQueue;
  frontendDir?: string | null;
  /** Route-level deps overrides (fetch seams, suite bases, adapter). */
  routesOverrides?: Partial<RoutesDeps>;
  env?: NodeJS.ProcessEnv;
}

export interface AiEvalApp {
  /** The Bun.serve-compatible fetch handler (in-process testing seam). */
  fetch(req: Request): Promise<Response>;
  readonly db: AiEvalDb;
  readonly sse: SseState;
  readonly queue: JobQueue;
  readonly routes: NlqEvalApp;
  readonly startTime: number;
  /** Resolved on-disk frontend build dir (null when forced off). */
  readonly frontendDir: string | null;
  /** /health handler (reused by server.ts routes). */
  health(): Response;
  /**
   * Tier-1 on-disk SPA/static serving. Returns a Response for a matched asset
   * or the (normalized) index.html, or `null` when there is no usable on-disk
   * build (so the caller can fall through to tier 2 embedded / tier 3
   * placeholder).
   */
  serveSpa(pathname: string): Response | null;
  /** Tier-3 placeholder page. */
  placeholder(): Response;
}

/** Build the full app (routes + /health + SPA fallback). */
export function createApp(opts: AppOptions = {}): AiEvalApp {
  const env = opts.env ?? process.env;
  let db = opts.db;
  if (!db) {
    const dbPath = resolveDbPath(env);
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new AiEvalDb(dbPath);
  }
  db.initDb();
  const sse = opts.sse ?? new SseState(db);
  const queue = opts.queue ?? new JobQueue();
  const frontendDir =
    opts.frontendDir !== undefined ? opts.frontendDir : resolveFrontendDir(env);

  const routes = createNlqEvalApp({
    db,
    sse,
    queue,
    ...opts.routesOverrides,
  });
  routes.init();

  const startTime = Date.now();

  function health(): Response {
    const status: Record<string, unknown> = {
      status: "healthy",
      timestamp: Date.now() / 1000,
      services: {} as Record<string, unknown>,
    };
    const services = status.services as Record<string, unknown>;
    try {
      db!.getActiveRunIds();
      services.sqlite = { status: "healthy" };
    } catch (e) {
      services.sqlite = {
        status: "unhealthy",
        error: e instanceof Error ? e.message : String(e),
      };
      status.status = "degraded";
    }
    const workerOk = queue.isAlive() || queue.pendingCount() === 0;
    services.worker = {
      // The async queue is "healthy" whenever it can accept work — it goes
      // idle (not alive) between jobs by design, unlike a daemon
      // thread. Treat idle-but-ready as healthy.
      status: "healthy",
      pending_jobs: queue.pendingCount(),
      alive: queue.isAlive(),
    };
    void workerOk;
    status.uptime_seconds =
      Math.round((Date.now() - startTime) / 100) / 10;
    return new Response(JSON.stringify(status), {
      status: status.status === "healthy" ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * On-disk (dev / TABLEAU_AI_EVAL_FRONTEND_DIR override) static + SPA serving.
   *
   * This is TIER 1 of the three-tier static resolution (see startServer in
   * src/server.ts for the full precedence doc):
   *   1. On-disk frontend build (this function)      — dev + override
   *   2. Embedded HTMLBundle (compiled binary)        — via server.ts routes
   *   3. PLACEHOLDER_HTML                             — neither present
   *
   * Returns `null` when there is no usable on-disk dir, so the server can fall
   * through to tier 2/3.
   */
  function serveSpa(pathname: string): Response | null {
    if (!frontendDir || !existsSync(frontendDir)) return null;

    const root = resolve(frontendDir);
    const rel = pathname.replace(/^\/+/, "");
    if (rel) {
      const resolvedAsset = resolve(join(root, rel));
      // Guard against path traversal: the asset must stay inside frontendDir.
      // isPathInside is separator-agnostic (works on Windows, where resolve()
      // uses `\`).
      if (
        isPathInside(root, resolvedAsset) &&
        existsSync(resolvedAsset) &&
        safeIsFile(resolvedAsset)
      ) {
        return fileResponse(resolvedAsset);
      }
    }
    const index = join(root, "index.html");
    if (existsSync(index)) return indexResponse(index);
    return null;
  }

  /** Serve a static asset with a pinned Content-Type + weak ETag (mtime/size). */
  function fileResponse(absPath: string): Response {
    const headers: Record<string, string> = {};
    const mime = mimeFor(absPath);
    if (mime) headers["Content-Type"] = mime;
    try {
      const st = statSync(absPath);
      headers.ETag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    } catch {}
    return new Response(Bun.file(absPath), { headers });
  }

  /**
   * Serve the on-disk index.html for SPA routes. Vite is configured with
   * `base: "./"` so the built index references assets as `./assets/...`; that
   * only resolves correctly at `/`. For deep SPA routes (`/foo/bar`) the browser
   * would resolve `./assets` against `/foo/`, so we normalize the asset refs
   * back to root-absolute `/assets/...` when serving from disk. (The embedded
   * HTMLBundle path re-hashes assets to root-absolute URLs itself, so this only
   * applies to tier 1.)
   */
  function indexResponse(indexPath: string): Response {
    let html: string;
    try {
      html = readFileSync(indexPath, "utf8");
    } catch {
      return new Response(Bun.file(indexPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    html = html
      .replace(/(src|href)="\.\/assets\//g, '$1="/assets/')
      .replace(/(src|href)="\.\/([^"/][^"]*)"/g, '$1="/$2"');
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  /** The documented placeholder page (tier 3). */
  function placeholder(): Response {
    return new Response(PLACEHOLDER_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") return health();

    // NLQ-eval routes own /nlq-eval/*, /results-classic/*, and the results
    // JSON/DELETE under /nlq-eval/results/*. Everything else falls to the SPA.
    if (
      path.startsWith("/nlq-eval/") ||
      path.startsWith("/results-classic/")
    ) {
      return routes.handle(req);
    }

    // SPA catch-all (GET only). Tier 1 = on-disk build;
    // if there is no on-disk build the in-process fetch seam falls straight to
    // the placeholder (tier 3). The embedded HTMLBundle (tier 2) is wired only
    // in the real Bun.serve `routes` (src/server.ts), not in this in-process
    // seam — HTMLBundle needs a bound server to bundle/serve its assets.
    if (req.method === "GET") return serveSpa(path) ?? placeholder();
    return new Response("Not Found", { status: 404 });
  }

  return {
    fetch,
    db,
    sse,
    queue,
    routes,
    startTime,
    frontendDir,
    health,
    serveSpa,
    placeholder,
  };
}

function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
