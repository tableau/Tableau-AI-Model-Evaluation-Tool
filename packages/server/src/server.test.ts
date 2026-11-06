/**
 * Server-wiring tests — the Bun.serve `routes` map + `fetch` fallback built by
 * startServer(). Binds an ephemeral port (port 0) so nothing collides, and
 * exercises the three-tier static precedence + API delegation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { SseState } from "@tableau-ai-eval/core";
import { JobQueue } from "./worker/queue.ts";
import { createApp, type AiEvalApp } from "./app.ts";
import { startServer } from "./server.ts";
import { RunLifecycle } from "@tableau-ai-eval/core";

function makeApp(frontendDir: string | null): AiEvalApp {
  const db = new AiEvalDb(":memory:");
  db.initDb();
  return createApp({
    db,
    sse: new SseState(db),
    queue: new JobQueue({ acquireInhibitor: () => ({ release() {} }) }),
    frontendDir,
  });
}

describe("startServer — placeholder (tier 3, no on-disk build, no embedded bundle)", () => {
  let app: AiEvalApp;
  let server: Server<unknown>;
  let base: string;

  beforeEach(async () => {
    app = makeApp(null);
    server = await startServer(app, {
      hostname: "127.0.0.1",
      port: 0,
      loadBundle: async () => null, // force no embedded bundle
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    app.db.close();
  });

  it("/health returns healthy JSON", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(((await r.json()) as { status: string }).status).toBe("healthy");
  });

  it("upgrades one observation socket for multiple runs while HTTP remains available", async () => {
    const lifecycle = new RunLifecycle(app.db, app.sse);
    for (const id of ["ws-a", "ws-b"]) {
      app.db.createRun({ job_id: id, org_id: "", user_id: "", ai_feature: "", runner_name: "", config: {} });
      lifecycle.patch(id, { status: "queued" });
    }
    const ws = new WebSocket(base.replace("http:", "ws:") + "/nlq-eval/observe");
    try {
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
      const snapshots = new Promise<void>(resolve => {
        let count = 0;
        ws.onmessage = event => {
          const data = JSON.parse(String(event.data));
          if (data.message?.type === "snapshot" && ++count === 2) resolve();
        };
      });
      for (const id of ["ws-a", "ws-b"]) ws.send(JSON.stringify({ type: "subscribe", jobId: id, subscriptionId: id }));
      await snapshots;
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally { ws.close(); }
  });

  it("/nlq-eval/suites is delegated to routes.handle (JSON)", async () => {
    const r = await fetch(`${base}/nlq-eval/suites`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
  });

  it("unknown GET falls to the placeholder page", async () => {
    const r = await fetch(`${base}/some/spa/route`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    expect(await r.text()).toContain("Tableau AI Model Evaluation Tool");
  });
});

describe("startServer — on-disk build (tier 1) preferred over embedded", () => {
  let app: AiEvalApp;
  let server: Server<unknown>;
  let base: string;
  let feDir: string;
  let loaderCalled: boolean;

  beforeEach(async () => {
    feDir = mkdtempSync(join(tmpdir(), "tableau-ai-eval-srv-"));
    mkdirSync(join(feDir, "assets"), { recursive: true });
    writeFileSync(
      join(feDir, "index.html"),
      '<!doctype html><title>Tableau AI Model Evaluation Tool</title>' +
        '<script src="./assets/app.js"></script>',
    );
    writeFileSync(join(feDir, "assets", "app.js"), 'console.log("disk");');
    app = makeApp(feDir);
    // Even if a bundle "existed", tier 1 wins because frontendDir is set;
    // startServer must not consult the bundle loader in that case.
    loaderCalled = false;
    server = await startServer(app, {
      hostname: "127.0.0.1",
      port: 0,
      loadBundle: async () => {
        loaderCalled = true;
        return {};
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    app.db.close();
    rmSync(feDir, { recursive: true, force: true });
  });

  it("does not consult the embedded bundle when an on-disk dir is set", () => {
    expect(loaderCalled).toBe(false);
  });

  it("serves the on-disk JS asset with the right Content-Type", async () => {
    const r = await fetch(`${base}/assets/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/javascript");
    expect(await r.text()).toContain('console.log("disk")');
  });

  it("serves index.html for an unknown SPA route", async () => {
    const r = await fetch(`${base}/deep/route`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    expect(await r.text()).toContain("Tableau AI Model Evaluation Tool");
  });
});

describe("startServer — dev UI redirect (devUiUrl set)", () => {
  let app: AiEvalApp;
  let server: Server<unknown>;
  let base: string;
  let feDir: string;
  let loaderCalled: boolean;

  beforeEach(async () => {
    // A stale on-disk build exists, but the dev redirect must win over it.
    feDir = mkdtempSync(join(tmpdir(), "tableau-ai-eval-srv-"));
    writeFileSync(join(feDir, "index.html"), "<!doctype html><title>stale</title>");
    app = makeApp(feDir);
    loaderCalled = false;
    server = await startServer(app, {
      hostname: "127.0.0.1",
      port: 0,
      devUiUrl: "http://localhost:5173/",
      loadBundle: async () => {
        loaderCalled = true;
        return {};
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    app.db.close();
    rmSync(feDir, { recursive: true, force: true });
  });

  it("redirects UI GETs to the dev server, preserving path and query", async () => {
    const r = await fetch(`${base}/runs/abc?tab=charts`, { redirect: "manual" });
    expect(r.status).toBe(307);
    expect(r.headers.get("Location")).toBe("http://localhost:5173/runs/abc?tab=charts");
  });

  it("redirects the root and never consults the embedded bundle", async () => {
    const r = await fetch(`${base}/`, { redirect: "manual" });
    expect(r.status).toBe(307);
    expect(r.headers.get("Location")).toBe("http://localhost:5173/");
    expect(loaderCalled).toBe(false);
  });

  it("still serves API routes directly", async () => {
    expect((await fetch(`${base}/health`, { redirect: "manual" })).status).toBe(200);
    const r = await fetch(`${base}/nlq-eval/suites`, { redirect: "manual" });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("startServer — embedded bundle (tier 2) serves the public/ root files", () => {
  let app: AiEvalApp;
  let server: Server<unknown>;
  let base: string;
  let assetDir: string;

  beforeEach(async () => {
    // Embedded public/ files are read via Bun.file(path); point them at real
    // temp files so the route can stream them (stand-in for the --compile
    // embedded paths).
    assetDir = mkdtempSync(join(tmpdir(), "tableau-ai-eval-public-"));
    writeFileSync(join(assetDir, "logo192.png"), "PNG-BYTES-192");
    writeFileSync(join(assetDir, "manifest.json"), '{"name":"x"}');
    writeFileSync(join(assetDir, "tableau-logo.png"), "PNG-BYTES-LOGO");
    app = makeApp(null); // no on-disk build → tier 2
    server = await startServer(app, {
      hostname: "127.0.0.1",
      port: 0,
      loadBundle: async () => ({ GET: () => new Response("index", { headers: { "Content-Type": "text/html" } }) }), // a truthy embedded bundle stand-in
      loadPublic: async () => ({
        "/logo192.png": {
          file: join(assetDir, "logo192.png"),
          contentType: "image/png",
        },
        "/manifest.json": {
          file: join(assetDir, "manifest.json"),
          contentType: "application/json; charset=utf-8",
        },
        "/tableau-logo.png": {
          file: join(assetDir, "tableau-logo.png"),
          contentType: "image/png",
        },
      }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    app.db.close();
    rmSync(assetDir, { recursive: true, force: true });
  });

  it("serves /logo192.png as image/png (not the SPA fallback)", async () => {
    const r = await fetch(`${base}/logo192.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect(await r.text()).toBe("PNG-BYTES-192");
  });

  it("serves /manifest.json as JSON", async () => {
    const r = await fetch(`${base}/manifest.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(((await r.json()) as { name: string }).name).toBe("x");
  });

  it("serves /tableau-logo.png (the header logo) as image/png, not the SPA fallback", async () => {
    const r = await fetch(`${base}/tableau-logo.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect(await r.text()).toBe("PNG-BYTES-LOGO");
  });
});

describe("startServer — native Bun.serve API routing (bound server)", () => {
  let app: AiEvalApp;
  let server: Server<unknown>;
  let base: string;

  beforeEach(async () => {
    app = makeApp(null);
    server = await startServer(app, {
      hostname: "127.0.0.1",
      port: 0,
      loadBundle: async () => null,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    app.db.close();
  });

  it("dispatches a native per-path GET route", async () => {
    const r = await fetch(`${base}/nlq-eval/suites`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
  });

  it("extracts a native :id param (status of unknown job -> 404 JSON)", async () => {
    const r = await fetch(`${base}/nlq-eval/status/nope`);
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(((await r.json()) as { reason: string }).reason).toBe("unknown_job");
  });

  it("URL-decodes native :id params", async () => {
    // A space-encoded id still resolves to the status handler (unknown -> 404
    // JSON), proving the param route matched with a decoded value.
    const r = await fetch(`${base}/nlq-eval/status/a%20b`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { reason: string }).reason).toBe("unknown_job");
  });

  it("wrong method on a known API path returns JSON 404 (not 405)", async () => {
    // /nlq-eval/suites is GET-only; POST must funnel through the /nlq-eval/*
    // wildcard to handle() and return {error:'not found'}, matching the
    // pre-rewrite dispatcher contract (Bun would otherwise 405).
    const r = await fetch(`${base}/nlq-eval/suites`, { method: "POST" });
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(((await r.json()) as { error: string }).error).toBe("not found");
  });

  it("unmatched /nlq-eval/* path returns JSON 404 {error:'not found'}", async () => {
    const r = await fetch(`${base}/nlq-eval/does-not-exist`);
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(((await r.json()) as { error: string }).error).toBe("not found");
  });

  it("results-classic is served (HTML) via its own route group", async () => {
    const r = await fetch(`${base}/results-classic/nope`);
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    expect(await r.text()).toContain("Job not found");
  });

  it("dispatches the two-param dashboard routes (unknown run -> JSON 404)", async () => {
    for (const path of ["/nlq-eval/dashboards/nope/abc", "/nlq-eval/dashboards/nope/abc/image",
                        "/nlq-eval/dashboards/nope/..%2F..%2Fetc/image"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(404);
      expect(r.headers.get("Content-Type")).toContain("application/json");
      expect(((await r.json()) as { error?: string }).error).not.toBe("not found");
    }
  });
});
