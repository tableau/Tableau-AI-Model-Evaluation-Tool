/**
 * Bun.serve construction — builds the `routes` map + `fetch` fallback and binds
 * the port. Routing config lives here (with the app) instead of in cli.ts.
 *
 * ## Static serving precedence (three tiers)
 * When a request is NOT an API route (/health, /nlq-eval/*, /results-classic/*),
 * the UI is served in this precedence order:
 *
 *   TIER 1 — On-disk frontend build (dev + TABLEAU_AI_EVAL_FRONTEND_DIR override)
 *            `app.serveSpa(path)` reads files from resolveFrontendDir() via
 *            Bun.file with a path-traversal guard, pinned Content-Types and a
 *            weak ETag; index.html is served (asset refs normalized to
 *            root-absolute) for unknown SPA routes. Wins whenever the dir
 *            exists on disk. This is the dev/override path.
 *
 *   TIER 2 — Embedded HTMLBundle (compiled binary)
 *            When there is no on-disk dir but an HTMLBundle was embedded by
 *            `bun build --compile` (see src/frontend_bundle.ts), it is wired as
 *            the `"/"` and `"/*"` route values. Bun serves the bundled
 *            index.html and re-hashed, root-absolute assets (`/chunk-*.js`,
 *            `/favicon-*.ico`, ...) directly and automatically. `"/*"` gives
 *            SPA-fallback semantics; the more specific API routes take
 *            precedence over it.
 *
 *   TIER 3 — PLACEHOLDER_HTML
 *            Neither an on-disk build nor an embedded bundle — documented
 *            placeholder page (via the fetch fallback / app.placeholder()).
 *
 * Dev override: when `devUiUrl` is set (`bun dev` passes the Vite origin via
 * TABLEAU_AI_EVAL_DEV_UI_URL), none of the tiers apply — every non-API GET is
 * redirected to the Vite dev server, so :8000 can never show a stale build.
 *
 * `routes` take precedence over `fetch`; `fetch` is the fallback for unmatched
 * requests. API routes are wired as wildcard route values delegating to the
 * existing `app.routes.handle(req)` so the 20 handlers are not rewritten.
 */

import type { Server } from "bun";
import { existsSync } from "node:fs";
import type { AiEvalApp } from "./app.ts";
import { observationSocket, type ObservationSocketData } from "./routes/observation_socket.ts";

type AnyServer = Server<ObservationSocketData>;

/**
 * Load the embedded HTMLBundle if present. Dynamic import so that dev/test
 * builds without a `frontend/build/index.html` don't fail to resolve the static
 * import inside frontend_bundle.ts (the throw is caught here). `bun --compile`
 * still traces through this dynamic import to embed the bundle. See
 * src/frontend_bundle.ts for the full rationale.
 */
export async function loadFrontendBundle(): Promise<unknown | null> {
  try {
    const mod = await import("./frontend_bundle.ts");
    return mod.default ?? null;
  } catch {
    return null;
  }
}

/**
 * Load the embedded `public/` root static files (favicon, PWA manifest + logos,
 * robots). Dynamic import mirrors loadFrontendBundle so a dev/test build that
 * cannot resolve them doesn't throw. See src/public_assets.ts for why these are
 * embedded separately from the HTMLBundle.
 */
export async function loadPublicAssets(): Promise<Record<
  string,
  { file: string; contentType: string }
> | null> {
  try {
    const mod = await import("./public_assets.ts");
    return (mod.default as Record<string, { file: string; contentType: string }>) ?? null;
  } catch {
    return null;
  }
}

export interface StartServerOptions {
  hostname: string;
  port: number;
  /** Injectable bundle loader (tests). Defaults to loadFrontendBundle. */
  loadBundle?: () => Promise<unknown | null>;
  /** Injectable public-asset loader (tests). Defaults to loadPublicAssets. */
  loadPublic?: () => Promise<Record<string, { file: string; contentType: string }> | null>;
  /**
   * Origin of a dev UI server (Vite). When set, non-API GETs redirect there
   * (path + query preserved) instead of serving any built UI.
   */
  devUiUrl?: string;
}

/**
 * Build the Bun.serve `routes` + `fetch` fallback for an app and bind the port.
 * Keeps `idleTimeout: 0` so long-lived SSE streams are not culled.
 */
export async function startServer(
  app: AiEvalApp,
  opts: StartServerOptions,
): Promise<AnyServer> {
  const loadBundle = opts.loadBundle ?? loadFrontendBundle;
  const loadPublic = opts.loadPublic ?? loadPublicAssets;

  // Tier 1 wins only when the frontend dir actually EXISTS on disk. `frontendDir`
  // is almost always a truthy default path (<binary-dir>/frontend/build) even
  // when nothing is there, so we must check the filesystem — not just the
  // string — before deciding whether to fall back to the embedded bundle.
  const devUiUrl = opts.devUiUrl?.replace(/\/+$/, "") || null;
  const hasOnDisk = !devUiUrl && Boolean(app.frontendDir) && existsSync(app.frontendDir as string);

  // Tier 2 is only consulted when there is no on-disk build to prefer.
  const bundle = devUiUrl || hasOnDisk ? null : await loadBundle();

  const routes: Record<string, unknown> = {
    "/nlq-eval/observe": (req: Request, server: AnyServer) => {
      if (req.method === "GET" && server.upgrade(req, { data: { subscriptions: new Map(), closed: false } })) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    // API — native Bun.serve per-path routes generated from the single route
    // table in routes/nlq_eval.ts (real `:id` params via req.params). The
    // wildcards below catch wrong-method/unmatched API paths and funnel them to
    // handle(), which returns the JSON `{error:"not found"}` 404 — preserving
    // the pre-rewrite contract (Bun does NOT 405; it falls through to the
    // matching wildcard). A listed path+method wins over its wildcard sibling.
    "/health": { GET: () => app.health() },
    ...app.routes.bunRoutes(),
    "/nlq-eval/*": (req: Request) => app.routes.handle(req),
    "/results-classic/*": (req: Request) => app.routes.handle(req),
  };

  if (bundle) {
    // Tier 2: embedded UI. "/" for the root, "/*" for SPA fallback. Bun serves
    // the bundle's re-hashed assets automatically; API routes above win over
    // the "/*" wildcard.
    routes["/"] = bundle;
    routes["/*"] = bundle;

    // The Vite `public/` root files (favicon, PWA manifest + logos, robots) are
    // referenced only by URL, so they are NOT in the HTMLBundle graph and would
    // otherwise fall through "/*" to index.html — the PWA icon then fails with
    // "resource isn't a valid image". Serve the embedded copies explicitly;
    // these exact paths win over the "/*" wildcard. Only needed in tier 2
    // (tier 1 serves them from the on-disk build dir).
    const publicAssets = await loadPublic();
    if (publicAssets) {
      for (const [path, asset] of Object.entries(publicAssets)) {
        routes[path] = {
          GET: () =>
            new Response(Bun.file(asset.file), {
              headers: { "Content-Type": asset.contentType },
            }),
        };
      }
    }
  }

  const server = Bun.serve<ObservationSocketData>({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: 0, // SSE streams are long-lived
    websocket: observationSocket(app.db, app.sse),
    routes: routes as never,
    // Fallback: tier 1 (on-disk) then tier 3 (placeholder). When an embedded
    // bundle is wired, unmatched GETs already hit "/*"; this handles the
    // no-bundle case and any non-GET.
    fetch(req: Request): Response | Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET") {
        if (devUiUrl) return Response.redirect(`${devUiUrl}${url.pathname}${url.search}`, 307);
        const onDisk = app.serveSpa(url.pathname);
        if (onDisk) return onDisk;
        if (!bundle) return app.placeholder();
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return server;
}
