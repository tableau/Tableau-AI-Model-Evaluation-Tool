import { test, expect } from "bun:test";
import {
  TableauPublisher,
  publishRun,
  HttpError,
  SchemaMismatch,
  SCHEMA_TAG,
  type FileReader,
} from "./hyper.ts";
import { TableauSession } from "@tableau-ai-eval/core";
import type { Export } from "./export.ts";

// A stub .hyper file reader — no real Hyper needed for REST tests.
const stubFiles: FileReader = {
  async readBytes() {
    return new Uint8Array([1, 2, 3, 4]);
  },
  async size() {
    return 4;
  },
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch stub scripted by (method, url-substring) → Response. */
function makeFetch(
  handlers: Array<{
    match: (url: string, init: RequestInit) => boolean;
    resp: () => Response;
    record?: (url: string, init: RequestInit) => void;
  }>,
) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    calls.push({
      url: u,
      method: (i.method as string) ?? "GET",
      headers: (i.headers as Record<string, string>) ?? {},
    });
    for (const h of handlers) {
      if (h.match(u, i)) {
        h.record?.(u, i);
        return h.resp();
      }
    }
    throw new Error(`unhandled fetch: ${i.method} ${u}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function sessionWith(fetchImpl: typeof fetch): TableauSession {
  return new TableauSession({
    serverUrl: "https://tableau.example.com",
    patName: "pat",
    patSecret: "secret",
    siteContentUrl: "",
    fetchImpl,
  });
}

const SIGNIN = (u: string) => u.includes("/auth/signin");
const signinResp = () =>
  jsonResp({ credentials: { token: "TOK-123", site: { id: "SITE-1" } } });

test("findOrCreateProject: returns existing id without creating", async () => {
  const { fn } = makeFetch([
    { match: SIGNIN, resp: signinResp },
    {
      match: (u, i) => u.includes("/projects") && (i.method ?? "GET") === "GET",
      resp: () => jsonResp({ projects: { project: [{ id: "PROJ-9" }] } }),
    },
  ]);
  const pub = new TableauPublisher(sessionWith(fn), { fetchImpl: fn, fileReader: stubFiles });
  const id = await pub.findOrCreateProject("AI Model Evaluations");
  expect(id).toBe("PROJ-9");
});

test("findOrCreateProject: creates when absent", async () => {
  const { fn, calls } = makeFetch([
    { match: SIGNIN, resp: signinResp },
    {
      match: (u, i) => u.includes("/projects") && (i.method ?? "GET") === "GET",
      resp: () => jsonResp({ projects: { project: [] } }),
    },
    {
      match: (u, i) => u.includes("/projects") && i.method === "POST",
      resp: () => jsonResp({ project: { id: "PROJ-NEW" } }),
    },
  ]);
  const pub = new TableauPublisher(sessionWith(fn), { fetchImpl: fn, fileReader: stubFiles });
  const id = await pub.findOrCreateProject("AI Model Evaluations");
  expect(id).toBe("PROJ-NEW");
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/projects"));
  expect(post).toBeTruthy();
  // X-Tableau-Auth applied.
  expect(post!.headers["X-Tableau-Auth"]).toBe("TOK-123");
});

test("findDatasource: matches by project id", async () => {
  const { fn } = makeFetch([
    { match: SIGNIN, resp: signinResp },
    {
      match: (u) => u.includes("/datasources"),
      resp: () =>
        jsonResp({
          datasources: {
            datasource: [
              { id: "DS-A", project: { id: "OTHER" } },
              { id: "DS-B", project: { id: "PROJ-9" } },
            ],
          },
        }),
    },
  ]);
  const pub = new TableauPublisher(sessionWith(fn), { fetchImpl: fn, fileReader: stubFiles });
  expect(await pub.findDatasource("AI Model Evaluation Results", "PROJ-9")).toBe("DS-B");
  expect(await pub.findDatasource("x", "MISSING")).toBe(null);
});

const EXP = { run: { run_id: "job-1" }, cases: [] } as unknown as Export;
const fakeBuild = async () => ({ results: 2, metrics: 4 });

/** Scripted create-or-append flow; `existing` = the listed datasource (or none). */
function publishFlow(existing: Record<string, unknown> | null) {
  const puts: Array<{ url: string; body: string }> = [];
  const { fn, calls } = makeFetch([
    { match: SIGNIN, resp: signinResp },
    {
      match: (u, i) => u.includes("/projects") && (i.method ?? "GET") === "GET",
      resp: () => jsonResp({ projects: { project: [{ id: "PROJ-9" }] } }),
    },
    {
      match: (u, i) => u.includes("/datasources?") && (i.method ?? "GET") === "GET",
      resp: () => jsonResp({ datasources: { datasource: existing ? [existing] : [] } }),
    },
    {
      match: (u, i) => u.includes("/datasources?") && i.method === "POST",
      resp: () => jsonResp({ datasource: { id: "DS-NEW" } }),
    },
    {
      match: (u, i) => u.endsWith("/tags") && i.method === "PUT",
      resp: () => jsonResp({ tags: {} }),
      record: (u, i) => puts.push({ url: u, body: i.body as string }),
    },
    {
      match: (u, i) => u.includes("/fileUploads") && i.method === "POST",
      resp: () => jsonResp({ fileUpload: { uploadSessionId: "UP-1" } }),
    },
    {
      match: (u, i) => u.includes("/fileUploads/UP-1") && i.method === "PUT",
      resp: () => jsonResp({}),
    },
    {
      match: (u, i) => u.includes("/data") && i.method === "PATCH",
      resp: () => jsonResp({ job: { id: "JOB-9" } }),
    },
  ]);
  const run = () =>
    publishRun(EXP, {
      session: sessionWith(fn),
      fetchImpl: fn,
      fileReader: stubFiles,
      hyperPath: "/tmp/does-not-matter.hyper",
      buildHyperImpl: fakeBuild,
    });
  return { run, calls, puts };
}

test("publishRun: first publish creates the datasource and tags it with the schema version", async () => {
  const { run, puts } = publishFlow(null);
  const res = await run();
  expect(res.action).toBe("created");
  expect(res.datasource_id).toBe("DS-NEW");
  expect(res.schema_version).toBe(3);
  expect(res.datasource).toBe("AI Model Evaluation Results");
  expect(res.rows).toEqual({ results: 2, metrics: 4 });
  expect(puts.length).toBe(1);
  expect(puts[0].url).toEndWith("/datasources/DS-NEW/tags");
  expect(JSON.parse(puts[0].body)).toEqual({ tags: { tag: [{ label: SCHEMA_TAG }] } });
});

test("publishRun: a tagged datasource is appended to", async () => {
  const { run, puts } = publishFlow({
    id: "DS-1",
    project: { id: "PROJ-9" },
    tags: { tag: [{ label: SCHEMA_TAG }] },
  });
  const res = await run();
  expect(res.action).toBe("appended");
  expect(res.append_job_id).toBe("JOB-9");
  expect(puts.length).toBe(0);
});

test("publishRun: refuses a datasource from an earlier schema before uploading anything", async () => {
  const { run, calls } = publishFlow({ id: "DS-OLD", project: { id: "PROJ-9" } });
  const err = await run().catch((e) => e);
  expect(err).toBeInstanceOf(SchemaMismatch);
  const msg = (err as Error).message;
  expect(msg).toContain("earlier version");
  expect(msg).toContain("Rename or delete");
  expect(msg).toContain(SCHEMA_TAG);
  expect(SCHEMA_TAG).toBe("ai-model-eval-schema-3");
  expect(calls.some((c) => c.url.includes("/fileUploads") || c.method === "PATCH")).toBe(false);
});

test("datasourceTags reads the listed tag labels", () => {
  expect(
    TableauPublisher.datasourceTags({
      id: "ds-1",
      tags: { tag: [{ label: SCHEMA_TAG }, { label: "x" }] },
    }),
  ).toEqual(new Set([SCHEMA_TAG, "x"]));
  expect(TableauPublisher.datasourceTags({ id: "ds-1" })).toEqual(new Set());
});

test("append: uploads then PATCHes with insert action + RequestID", async () => {
  let patchHeaders: Record<string, string> = {};
  let patchBody = "";
  const { fn } = makeFetch([
    { match: SIGNIN, resp: signinResp },
    {
      match: (u, i) => u.includes("/fileUploads") && i.method === "POST",
      resp: () => jsonResp({ fileUpload: { uploadSessionId: "UP-1" } }),
    },
    {
      match: (u, i) => u.includes("/fileUploads/UP-1") && i.method === "PUT",
      resp: () => jsonResp({ fileUpload: { uploadSessionId: "UP-1" } }),
    },
    {
      match: (u, i) => u.includes("/data") && i.method === "PATCH",
      resp: () => jsonResp({ job: { id: "JOB-77" } }),
      record: (_u, i) => {
        patchHeaders = i.headers as Record<string, string>;
        patchBody = i.body as string;
      },
    },
  ]);
  const pub = new TableauPublisher(sessionWith(fn), { fetchImpl: fn, fileReader: stubFiles });
  const job = await pub.append("/tmp/x.hyper", "DS-B");
  expect(job.id).toBe("JOB-77");
  expect(patchHeaders["RequestID"]).toBeTruthy();
  expect(patchHeaders["Content-Type"]).toBe("application/json");
  const parsed = JSON.parse(patchBody);
  expect(parsed.actions[0]).toEqual({
    action: "insert",
    "source-table": "results",
    "target-table": "results",
  });
});

test("publishNew: eventual-consistency race (403) surfaces as HttpError", async () => {
  const { fn } = makeFetch([
    { match: SIGNIN, resp: signinResp },
    {
      match: (u, i) => u.includes("/datasources") && i.method === "POST",
      resp: () => jsonResp({ error: "duplicate name" }, 403),
    },
  ]);
  const pub = new TableauPublisher(sessionWith(fn), { fetchImpl: fn, fileReader: stubFiles });
  const err = await pub
    .publishNew("/tmp/x.hyper", "AI Model Evaluation Results", "PROJ-9")
    .catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(403);
});

// ---------------------------------------------------------------------------
// TLS ergonomics — the publisher's REST calls must honor the SAME
// verify/CA-bundle rules as TableauSession. Regression guard for the
// self-signed/private-CA publish failure: sign-in succeeded but every publisher
// REST call rejected the private CA because it ignored caBundlePath.
// ---------------------------------------------------------------------------

/** A fetch stub that records the full RequestInit (incl. `tls`) per call. */
function makeTlsRecordingFetch() {
  const calls: Array<{ url: string; method: string; tls: unknown }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit & { tls?: unknown };
    calls.push({ url: u, method: (i.method as string) ?? "GET", tls: i.tls });
    if (u.includes("/auth/signin")) return signinResp();
    if (u.includes("/projects")) return jsonResp({ projects: { project: [{ id: "PROJ-1" }] } });
    throw new Error(`unhandled fetch: ${i.method} ${u}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("publisher REST calls trust a private CA when verify=true + caBundlePath", async () => {
  const { fn, calls } = makeTlsRecordingFetch();
  const pub = new TableauPublisher(sessionWith(fn), {
    fetchImpl: fn,
    fileReader: stubFiles,
    verify: true,
    caBundlePath: "/tmp/tableau-ai-eval-ca.pem",
  });
  await pub.findOrCreateProject("AI Model Evaluations");
  const projectCall = calls.find((c) => c.url.includes("/projects"));
  expect(projectCall).toBeTruthy();
  // tlsInit(verify=true, caBundlePath) -> { tls: { ca: <BunFile> } }
  const tls = projectCall!.tls as { ca?: unknown; rejectUnauthorized?: boolean } | undefined;
  expect(tls).toBeTruthy();
  expect(tls!.ca).toBeTruthy();
  expect(tls!.rejectUnauthorized).toBeUndefined();
});

test("publisher REST calls disable verification when verify=false", async () => {
  const { fn, calls } = makeTlsRecordingFetch();
  const pub = new TableauPublisher(sessionWith(fn), {
    fetchImpl: fn,
    fileReader: stubFiles,
    verify: false,
  });
  await pub.findOrCreateProject("AI Model Evaluations");
  const projectCall = calls.find((c) => c.url.includes("/projects"));
  const tls = projectCall!.tls as { ca?: unknown; rejectUnauthorized?: boolean } | undefined;
  expect(tls).toBeTruthy();
  expect(tls!.rejectUnauthorized).toBe(false);
});

test("publisher REST calls use system trust when verify=true + no caBundlePath", async () => {
  const { fn, calls } = makeTlsRecordingFetch();
  const pub = new TableauPublisher(sessionWith(fn), {
    fetchImpl: fn,
    fileReader: stubFiles,
    verify: true,
  });
  await pub.findOrCreateProject("AI Model Evaluations");
  const projectCall = calls.find((c) => c.url.includes("/projects"));
  // No tls object attached (default Mozilla CA set).
  expect(projectCall!.tls).toBeUndefined();
});

test("SECURITY: publisher rejects self-signed by DEFAULT (no opts) — no TLS relaxation", async () => {
  // With no verify/caBundle opts at all, the publisher must NOT relax TLS:
  // no `rejectUnauthorized:false` and no injected `ca`. Bun then verifies
  // against the system CA set, so a self-signed/private cert is rejected unless
  // the user explicitly opted in (verify_tls=false) or ran `tableau-ai-eval trust`
  // (which writes ~/.tableau-ai-eval/ca.pem, surfaced via caBundlePath).
  const { fn, calls } = makeTlsRecordingFetch();
  const pub = new TableauPublisher(sessionWith(fn), {
    fetchImpl: fn,
    fileReader: stubFiles,
  });
  await pub.findOrCreateProject("AI Model Evaluations");
  const projectCall = calls.find((c) => c.url.includes("/projects"));
  expect(projectCall!.tls).toBeUndefined();
});
