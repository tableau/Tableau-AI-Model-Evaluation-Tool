/**
 * App-factory tests — /health and SPA/static fallback via the in-process
 * fetch handler (no port binding).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32, posix } from "node:path";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { SseState } from "@tableau-ai-eval/core";
import { JobQueue } from "./worker/queue.ts";
import { createApp, resolveDbPath, resolveFrontendDir, isPathInside, type AiEvalApp } from "./app.ts";

let app: AiEvalApp;

beforeEach(() => {
  const db = new AiEvalDb(":memory:");
  db.initDb();
  app = createApp({
    db,
    sse: new SseState(db),
    queue: new JobQueue({ acquireInhibitor: () => ({ release() {} }) }),
    frontendDir: null, // force placeholder
  });
});

afterEach(() => {
  app.db.close();
});

describe("GET /health", () => {
  it("reports healthy with sqlite + worker services", async () => {
    const r = await app.fetch(new Request("http://x/health"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      status: string;
      services: Record<string, { status: string }>;
      uptime_seconds: number;
    };
    expect(body.status).toBe("healthy");
    expect(body.services.sqlite.status).toBe("healthy");
    expect(body.services.worker.status).toBe("healthy");
    expect(typeof body.uptime_seconds).toBe("number");
  });
});

describe("SPA fallback", () => {
  it("serves the placeholder when no frontend build exists", async () => {
    const r = await app.fetch(new Request("http://x/some/spa/route"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    const text = await r.text();
    expect(text).toContain("Tableau AI Model Evaluation Tool");
  });

  it("mounts /nlq-eval routes (suites returns json, not the SPA)", async () => {
    const r = await app.fetch(new Request("http://x/nlq-eval/suites"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("env path resolution", () => {
  it("resolveDbPath honors TABLEAU_AI_EVAL_DATA_DIR", () => {
    const p = resolveDbPath({ TABLEAU_AI_EVAL_DATA_DIR: "/tmp/lexdata" } as NodeJS.ProcessEnv);
    // resolve/join: on Windows "/tmp/lexdata" becomes "C:\tmp\lexdata".
    expect(p).toBe(join(resolve("/tmp/lexdata"), "nlq_eval_results.db"));
  });

  it("resolveFrontendDir honors TABLEAU_AI_EVAL_FRONTEND_DIR", () => {
    const p = resolveFrontendDir({
      TABLEAU_AI_EVAL_FRONTEND_DIR: "/tmp/fe",
    } as NodeJS.ProcessEnv);
    expect(p).toBe(resolve("/tmp/fe"));
  });

  it("resolveFrontendDir defaults to packages/frontend/build in dev", () => {
    // No override + running from source (not a --compile binary) resolves to the
    // sibling `packages/frontend/build` so `bun start` serves the UI env-free.
    const p = resolveFrontendDir({} as NodeJS.ProcessEnv);
    expect(p.endsWith(join("packages", "frontend", "build"))).toBe(true);
  });
});

describe("isPathInside (separator-agnostic traversal guard)", () => {
  // Regression: on Windows, resolve() yields `\` separators, so the old
  // `child.startsWith(root + "/")` check rejected every legitimate asset and the
  // server served index.html for /assets/*.js|css. Drive both path flavors here
  // so the Windows behavior is covered even when the suite runs on POSIX.
  it("accepts assets inside the root (win32)", () => {
    const root = "C:\\Users\\me\\build";
    expect(isPathInside(root, "C:\\Users\\me\\build\\assets\\index.js", win32)).toBe(true);
    expect(isPathInside(root, root, win32)).toBe(true);
  });

  it("rejects traversal outside the root (win32)", () => {
    const root = "C:\\Users\\me\\build";
    expect(isPathInside(root, "C:\\Users\\me\\secret.txt", win32)).toBe(false);
    expect(isPathInside(root, "C:\\Windows\\System32\\x.dll", win32)).toBe(false);
  });

  it("accepts assets inside / rejects traversal (posix)", () => {
    const root = "/srv/build";
    expect(isPathInside(root, "/srv/build/assets/index.js", posix)).toBe(true);
    expect(isPathInside(root, "/srv/build", posix)).toBe(true);
    expect(isPathInside(root, "/etc/passwd", posix)).toBe(false);
    expect(isPathInside(root, "/srv/build-sibling/x", posix)).toBe(false);
  });
});

describe("on-disk frontend build (tier 1) via fetch seam", () => {
  let feApp: AiEvalApp;
  let feDir: string;

  beforeEach(() => {
    // Build a minimal on-disk frontend fixture with relative ("./") asset
    // refs, mirroring the Vite `base: "./"` output.
    feDir = mkdtempSync(join(tmpdir(), "tableau-ai-eval-fe-"));
    mkdirSync(join(feDir, "assets"), { recursive: true });
    writeFileSync(
      join(feDir, "index.html"),
      '<!doctype html><html><head><title>Tableau AI Model Evaluation Tool</title>' +
        '<script type="module" src="./assets/app.js"></script></head>' +
        '<body><div id="root"></div></body></html>',
    );
    writeFileSync(join(feDir, "assets", "app.js"), 'console.log("hi");');
    writeFileSync(join(feDir, "assets", "style.css"), "body{color:red}");
    const db = new AiEvalDb(":memory:");
    db.initDb();
    feApp = createApp({
      db,
      sse: new SseState(db),
      queue: new JobQueue({ acquireInhibitor: () => ({ release() {} }) }),
      frontendDir: feDir,
    });
  });

  afterEach(() => {
    feApp.db.close();
    rmSync(feDir, { recursive: true, force: true });
  });

  it("serves a JS asset with the right Content-Type", async () => {
    const r = await feApp.fetch(new Request("http://x/assets/app.js"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/javascript");
    expect(await r.text()).toContain('console.log("hi")');
  });

  it("serves a CSS asset with the right Content-Type", async () => {
    const r = await feApp.fetch(new Request("http://x/assets/style.css"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/css");
  });

  it("returns index.html (normalized to root-absolute assets) for an unknown SPA route", async () => {
    const r = await feApp.fetch(new Request("http://x/deep/spa/route"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Tableau AI Model Evaluation Tool");
    // Relative "./assets" refs are rewritten to root-absolute so deep routes work.
    expect(html).toContain('src="/assets/app.js"');
    expect(html).not.toContain('src="./assets/app.js"');
  });

  it("blocks path traversal outside the frontend dir", async () => {
    const r = await feApp.fetch(
      new Request("http://x/..%2f..%2f..%2fetc%2fpasswd"),
    );
    // Traversal is rejected -> falls through to the SPA index (200 html),
    // never the escaped file.
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
  });

  it("still routes API paths to JSON, not the SPA", async () => {
    const r = await feApp.fetch(new Request("http://x/nlq-eval/suites"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
  });
});
