/**
 * Sample content for Questions about a dashboard: the manifest, the generated
 * workbook, publishing through the REST API, and the ids remembered per site.
 * Regression tests use injected REST responses.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type EvalAdapter, AiEvalDb, SseState } from "@tableau-ai-eval/core";
import { createNlqEvalApp, type NlqEvalApp } from "../routes/nlq_eval.ts";
import { JobQueue } from "../worker/queue.ts";
import { listSuites } from "./catalog.ts";
import * as dc from "./dashboard_content.ts";
import type { SettingsStore } from "./public_content.ts";

const REPO_PUBLIC = join(import.meta.dir, "..", "..", "..", "..", "public-suites");
const ENV = { publicBase: REPO_PUBLIC };
// Questions about a dashboard is held back from this release and its sample
// content is out of the tree (catalog.ts, HELD_BACK_CAPABILITIES). Every test
// here reads that content, so they run again when the folder returns.
const CONTENT_PRESENT = existsSync(join(REPO_PUBLIC, "dashboard-qa"));

function memoryStore(): SettingsStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    getSetting: (k) => (data.has(k) ? structuredClone(data.get(k)) : null),
    setSetting: (k, v) => void data.set(k, structuredClone(v)),
  };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe.skipIf(!CONTENT_PRESENT)("manifest", () => {
  it("every dashboard-qa suite has sample content and the files ship", () => {
    const catalog = listSuites({ publicBase: REPO_PUBLIC }).filter(
      (s) => s.capability === "dashboard-qa" && !s.parts,
    );
    expect(catalog.length).toBe(31); // 16 parts + 11 declines parts + 4 smoke copies
    for (const suite of catalog) {
      const content = dc.suiteContent(suite.content!, ENV);
      expect([suite.id, content !== null]).toEqual([suite.id, true]);
      expect(content!.workbook.name && content!.workbook.dashboard).toBeTruthy();
      for (const ds of content!.datasources) {
        expect([suite.id, ds.file, ds.present]).toEqual([suite.id, ds.file, true]);
        expect(ds.sheet.dimension && ds.sheet.measure).toBeTruthy();
      }
    }
  });

  it("smoke suites share their full suite's content", () => {
    const full = dc.suiteContent("dashboard-qa-insurance", ENV)!;
    const smoke = dc.suiteContent("dashboard-qa-insurance-smoke", ENV)!;
    expect(smoke.workbook).toEqual(full.workbook);
    expect(smoke.datasources.map((d) => d.file)).toEqual(full.datasources.map((d) => d.file));
  });

  it("two-source suites list both sources in the order the cases expect", () => {
    const multi = dc.suiteContent("dashboard-qa-multi-datasource", ENV)!;
    expect(multi.datasources.map((d) => d.display_name)).toEqual([
      "Auto Insurance Claims",
      "Customer Lifetime Value",
    ]);
    expect(multi.datasources.map((d) => d.luid_key)).toEqual([
      "tabcabu_insurance_datasource_luid",
      "tabcabu_clv_datasource_luid",
    ]);
  });

  it("an unknown suite has no content", () => {
    expect(dc.suiteContent("calcs-public", ENV)).toBeNull();
    expect(dc.suiteContent("", ENV)).toBeNull();
    expect(dc.suiteContent("constructor", ENV)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

function attrs(xml: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*?\\s${attr}=(?:'([^']*)'|"([^"]*)")`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? m[2]!);
}

describe.skipIf(!CONTENT_PRESENT)("workbook", () => {
  it("points at the published sources and holds one dashboard", () => {
    const xml = dc.buildWorkbookXml("https://tableau.example.com", "Sales", "Insurance Claims and Customer Lifetime Value", [
      {
        caption: "Insurance Claims",
        content_url: "InsuranceClaimsAIevaluationsample",
        sheet: { dimension: "Business Line", measure: "Claim Paid Amount" },
      },
      { caption: "Customer Lifetime Value", content_url: "CLVsample", sheet: { dimension: "Segment", measure: "Sales" } },
    ]);
    const top = xml.slice(xml.indexOf("<datasources>"), xml.indexOf("</datasources>"));
    expect(attrs(top, "datasource", "caption")).toEqual(["Insurance Claims", "Customer Lifetime Value"]);
    expect(attrs(top, "connection", "class")).toEqual(["sqlproxy", "sqlproxy"]);
    expect(attrs(top, "connection", "dbname")).toEqual(["InsuranceClaimsAIevaluationsample", "CLVsample"]);
    expect(attrs(top, "connection", "server")).toEqual(["tableau.example.com", "tableau.example.com"]);
    expect(attrs(top, "connection", "port")).toEqual(["443", "443"]);
    expect(attrs(top, "repository-location", "path")[0]).toBe("/t/Sales/datasources");
    expect(attrs(xml, "worksheet", "name")).toEqual(["Sheet 1", "Sheet 2"]);
    expect(attrs(xml, "dashboard", "name")).toEqual(["Insurance Claims and Customer Lifetime Value"]);
    const dash = xml.slice(xml.indexOf("<dashboard "), xml.indexOf("</dashboard>"));
    expect(attrs(dash, "zone", "name")).toEqual(["Sheet 1", "Sheet 2"]);
    // The sheet reads the named fields of its own source.
    expect(xml).toContain("[Business Line]");
    expect(xml).toContain("[Claim Paid Amount]");
    // Every opened element is closed (a rough well-formedness check).
    const opened = [...xml.matchAll(/<([a-z][\w:-]*)\b[^>]*?(\/?)>/gi)].filter((m) => m[2] !== "/").length;
    const closed = [...xml.matchAll(/<\/[a-z][\w:-]*>/gi)].length;
    expect(opened).toBe(closed);
  });

  it("the default site has no site segment, and http uses port 80", () => {
    const xml = dc.buildWorkbookXml("http://tab.local", "", "D", [
      { caption: "A", content_url: "a", sheet: { dimension: "x", measure: "y" } },
    ]);
    expect(attrs(xml, "repository-location", "path")).toEqual(["/datasources"]);
    expect(attrs(xml, "connection", "port")).toEqual(["80"]);
    expect(attrs(xml, "connection", "channel")).toEqual(["http"]);
  });
});

// ---------------------------------------------------------------------------
// Publishing (REST calls faked)
// ---------------------------------------------------------------------------

const FAKE_SESSION: dc.PublisherSession = {
  serverUrl: "https://tableau.example.com",
  siteId: async () => "site-1",
  authHeaders: async () => ({ "X-Tableau-Auth": "tok" }),
};

interface Call {
  method: string;
  url: URL;
  body: Uint8Array | string | null;
  headers: Record<string, string>;
}

function fakeRest(calls: Call[], respond?: (c: Call) => Response | null): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: (init?.body as Uint8Array | string | null) ?? null,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const custom = respond?.(call);
    if (custom) return custom;
    const path = call.url.pathname;
    const ok = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status });
    if (call.method === "GET") return ok({ projects: { project: [] } }, 200);
    if (path.endsWith("/projects")) return ok({ project: { id: "proj-1" } });
    if (path.endsWith("/datasources")) return ok({ datasource: { id: "ds-1", name: "x", contentUrl: "dsurl" } });
    if (path.endsWith("/workbooks")) return ok({ workbook: { id: "wb-1", contentUrl: "wburl" } });
    throw new Error(String(input));
  }) as unknown as typeof fetch;
}

describe.skipIf(!CONTENT_PRESENT)("publishing", () => {
  it("publishes the sources, then the workbook, and remembers the ids", async () => {
    const calls: Call[] = [];
    const store = memoryStore();
    const conn = { server_url: "https://tableau.example.com/", site: "Sales", pat_name: "p", pat_value: "s" };
    const ids = await dc.publishSuiteContent("dashboard-qa-insurance", conn, {
      session: FAKE_SESSION,
      store,
      fetchImpl: fakeRest(calls),
      ...ENV,
    });

    expect(calls.map((c) => [c.method, c.url.pathname.split("/").pop()])).toEqual([
      ["GET", "projects"],
      ["POST", "projects"],
      ["POST", "datasources"],
      ["POST", "workbooks"],
    ]);
    expect(calls[0]!.url.pathname).toBe("/api/3.22/sites/site-1/projects");
    expect(calls[0]!.url.searchParams.get("filter")).toBe("name:eq:AI Model Evaluation Samples");
    const dsCall = calls[2]!;
    expect(Object.fromEntries(dsCall.url.searchParams)).toEqual({ datasourceType: "tdsx", overwrite: "true" });
    const dsBody = new TextDecoder("latin1").decode(dsCall.body as Uint8Array);
    expect(dsBody).toContain('name="tableau_datasource"');
    expect(dsBody).toContain("<tsRequest>");
    expect(dsCall.headers["Content-Type"]!.startsWith("multipart/mixed; boundary=")).toBe(true);
    expect(dsCall.headers["X-Tableau-Auth"]).toBe("tok");
    const wbCall = calls[3]!;
    expect(wbCall.url.searchParams.get("workbookType")).toBe("twb");
    expect(wbCall.url.searchParams.get("overwrite")).toBe("true");
    const wbBody = new TextDecoder().decode(wbCall.body as Uint8Array);
    expect(wbBody).toContain('dbname="dsurl"');
    expect(wbBody).toContain("Insurance Claims");

    expect(ids.workbook_luid).toBe("wb-1");
    expect(ids.datasources[0]!.luid).toBe("ds-1");
    expect(ids.datasources[0]!.content_url).toBe("dsurl");
    // Remembered for this site only, keyed without the trailing slash.
    expect(dc.storedContent(store, "https://tableau.example.com", "Sales", "dashboard-qa-insurance").workbook_luid).toBe(
      "wb-1",
    );
    expect(dc.storedContent(store, "https://tableau.example.com", "Other", "dashboard-qa-insurance")).toEqual({});
    const runIds = dc.runIdsFor(store, "dashboard-qa-insurance", "https://tableau.example.com", "Sales");
    expect(runIds.workbook_luid).toBe("wb-1");
    expect(runIds.datasource_luids).toEqual(["ds-1"]);
    expect(runIds.datasource_luid).toBe("ds-1");
    const status = dc.contentStatus(store, "https://tableau.example.com", "Sales", ENV);
    expect(status["dashboard-qa-insurance"]!.published).toBe(true);
    expect(status["dashboard-qa-clv"]!.published).toBe(false);
    dc.forgetContent(store, "https://tableau.example.com", "Sales", "dashboard-qa-insurance");
    expect(dc.runIdsFor(store, "dashboard-qa-insurance", "https://tableau.example.com", "Sales")).toEqual({});
  });

  it("a refusal from the server is worded for the admin", async () => {
    const store = memoryStore();
    const fetchImpl = fakeRest([], (c) =>
      c.method === "GET"
        ? new Response(JSON.stringify({ projects: { project: [{ id: "proj-1" }] } }), { status: 200 })
        : new Response(
            JSON.stringify({ error: { summary: "Forbidden", detail: "User lacks publish permission." } }),
            { status: 403 },
          ),
    );
    const err = await dc
      .publishSuiteContent("dashboard-qa-clv", { server_url: "https://t", site: "" }, {
        session: FAKE_SESSION,
        store,
        fetchImpl,
        ...ENV,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(dc.ContentPublishError);
    expect(err.message).toContain("refused to publish the data source");
    expect(err.message).toContain("User lacks publish permission.");
    expect(dc.runIdsFor(store, "dashboard-qa-clv", "https://t", "")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function buildApp(publish?: typeof dc.publishSuiteContent): {
  app: NlqEvalApp;
  db: AiEvalDb;
  queue: JobQueue;
  launched: Record<string, unknown>[];
} {
  const db = new AiEvalDb(":memory:");
  db.initDb();
  const queue = new JobQueue({ acquireInhibitor: () => ({ release() {} }) });
  const launched: Record<string, unknown>[] = [];
  let n = 0;
  const app = createNlqEvalApp({
    db,
    sse: new SseState(db),
    queue,
    suiteBases: { publicBase: REPO_PUBLIC },
    tableauFetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    genJobId: () => `dqc${++n}`,
    publishSuiteContent: publish,
    orchestratorOverrides: {
      getAdapter: async (cfg: Record<string, unknown>) => {
        launched.push({ ...cfg });
        const adapter: EvalAdapter = {
          id: "fake",
          session: () => ({ close() {} }),
          load: () => ({ total: 0, skeletons: [], conversation_ids: [], opaque: null }),
          execute: async () => {},
        };
        return adapter;
      },
    },
  });
  app.init();
  return { app, db, queue, launched };
}

type ContentStatusResponse = {
  configured: boolean;
  suites: Record<string, { published: boolean }>;
};
type SuitesResponse = {
  suites: { id: string; server_supported: boolean; server_message: string | null }[];
  dashboard_qa_off: { message: string } | null;
};

async function call<T = Record<string, unknown>>(app: NlqEvalApp, method: string, path: string, body?: unknown) {
  const r = await app.handle(
    new Request(`http://x${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    }),
  );
  return { status: r.status, body: await r.json() as T };
}

const CONNECTION = { server_url: "https://tableau.example.com", site: "Sales", pat_name: "p", pat_value: "secret" };

describe.skipIf(!CONTENT_PRESENT)("routes", () => {
  it("the status route lists every suite, and publishing needs a connection", async () => {
    const { app } = buildApp();
    const r = await call<ContentStatusResponse>(app, "GET", "/nlq-eval/dashboard-content");
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(false);
    expect(r.body.suites["dashboard-qa-superstore"].published).toBe(false);
    const p = await call(app, "POST", "/nlq-eval/dashboard-content/dashboard-qa-superstore/publish");
    expect(p.status).toBe(400);
    expect(p.body.error).toContain("Connect to Tableau Server");
  });

  it("an unknown suite has nothing to publish", async () => {
    const { app } = buildApp();
    await call(app, "PUT", "/nlq-eval/settings/tableau", CONNECTION);
    const p = await call(app, "POST", "/nlq-eval/dashboard-content/calcs-public/publish");
    expect(p.status).toBe(404);
    expect(p.body.reason).toBe("unknown_suite");
  });

  it("publishes with the stored connection, and a run then needs no ids", async () => {
    const seen: Record<string, unknown> = {};
    const { app, queue, launched } = buildApp(async (suiteId, conn, opts) => {
      seen.suite = suiteId;
      seen.pat = conn.pat_value;
      const ids = { workbook_luid: "wb-9", datasources: [{ luid: "ds-9", name: "n", content_url: "", display_name: null }] };
      dc.rememberContent(opts.store, String(conn.server_url), String(conn.site), suiteId, ids);
      return ids;
    });
    await call(app, "PUT", "/nlq-eval/settings/tableau", CONNECTION);
    const r = await call<{ ids: dc.PublishedContent }>(app, "POST", "/nlq-eval/dashboard-content/dashboard-qa-hls/publish");
    expect(r.status).toBe(200);
    expect(seen.suite).toBe("dashboard-qa-hls");
    expect(seen.pat).toBe("secret");
    expect(r.body.ids.workbook_luid).toBe("wb-9");
    expect((await call<ContentStatusResponse>(app, "GET", "/nlq-eval/dashboard-content")).body.suites["dashboard-qa-hls"].published).toBe(true);

    // A run of that suite gets the ids from the memory, nothing asked.
    const run = { runner: "cabu-dashboard-qa", adapter: "cabu", suite_id: "dashboard-qa-hls" };
    const started = await call(app, "POST", "/nlq-eval/run", run);
    expect(started.status).toBe(202);
    await queue.waitIdle();
    expect(launched[0]!.workbook_luid).toBe("wb-9");
    expect(launched[0]!.datasource_luids).toEqual(["ds-9"]);

    // A suite not published yet queues normally: the job publishes it first.
    const missing = await call(app, "POST", "/nlq-eval/run", { ...run, suite_id: "dashboard-qa-clv" });
    expect(missing.status).toBe(202);
    expect(missing.body.error).toBeUndefined();

    // Forgetting the ids puts the suite back to unpublished.
    expect((await call(app, "DELETE", "/nlq-eval/dashboard-content/dashboard-qa-hls")).status).toBe(200);
    expect((await call<ContentStatusResponse>(app, "GET", "/nlq-eval/dashboard-content")).body.suites["dashboard-qa-hls"].published).toBe(false);
  });

  it("a publishing failure is reported as one", async () => {
    const { app } = buildApp(async () => {
      throw new dc.ContentPublishError("Tableau Server refused to publish the workbook 'x' (HTTP 403).");
    });
    await call(app, "PUT", "/nlq-eval/settings/tableau", CONNECTION);
    const r = await call(app, "POST", "/nlq-eval/dashboard-content/dashboard-qa-hls/publish");
    expect(r.status).toBe(502);
    expect(r.body.reason).toBe("publish_failed");
  });

  it("a site with Dashboard Q&A off lists the suites as unsupported and refuses runs", async () => {
    const { app, db } = buildApp();
    await call(app, "PUT", "/nlq-eval/settings/tableau", CONNECTION);
    db.setSetting("tableau_preflight", {
      ok: true,
      identity: ["https://tableau.example.com", "Sales", "p"],
      dashboard_qa: { enabled: false, reason: "site_setting_off", message: "Tableau Agent in Dashboards is turned off for this site." },
    });
    const body = (await call<SuitesResponse>(app, "GET", "/nlq-eval/suites")).body;
    const suites = Object.fromEntries(body.suites.map((s) => [s.id, s]));
    expect(suites["dashboard-qa-hls"].server_supported).toBe(false);
    expect(suites["dashboard-qa-hls"].server_message).toContain("turned off");
    // The switch is the whole feature's: Dashboard Narratives is kept out too,
    // so the feature card's Evaluate is disabled with the reason (2026-11-04).
    expect(suites["dashboard-narratives-public"].server_supported).toBe(false);
    expect(suites["dashboard-narratives-public"].server_message).toContain("turned off");
    expect(suites["calcs-public"].server_supported).toBe(true);
    expect(body.dashboard_qa_off?.message).toBeTruthy();
    const r = await call(app, "POST", "/nlq-eval/run", {
      runner: "cabu-dashboard-qa",
      adapter: "cabu",
      suite_id: "dashboard-qa-hls",
    });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("dashboard_qa_disabled");
    const n = await call(app, "POST", "/nlq-eval/run", {
      runner: "narratives",
      adapter: "narratives",
      suite_id: "dashboard-narratives-public",
    });
    expect(n.status).toBe(400);
    expect(n.body.reason).toBe("dashboard_qa_disabled");
  });

  it("a build without the Q&A endpoint keeps Dashboard Narratives", async () => {
    // A 404 says the build lacks the endpoint, not that the site switch is
    // off: Questions about a dashboard is kept out, Dashboard Narratives is not.
    const { app, db } = buildApp();
    await call(app, "PUT", "/nlq-eval/settings/tableau", CONNECTION);
    db.setSetting("tableau_preflight", {
      ok: true,
      identity: ["https://tableau.example.com", "Sales", "p"],
      dashboard_qa: { enabled: false, reason: "not_found", message: "This Tableau Server build has no Dashboard Q&A endpoint." },
    });
    const body = (await call<SuitesResponse>(app, "GET", "/nlq-eval/suites")).body;
    const suites = Object.fromEntries(body.suites.map((s) => [s.id, s]));
    expect(suites["dashboard-qa-hls"].server_supported).toBe(false);
    expect(suites["dashboard-narratives-public"].server_supported).toBe(true);
  });
});


describe.skipIf(!CONTENT_PRESENT)("remembered content that no longer matches the suite", () => {
  it("is not published any more, and the run publishes the current content (2026-10-21)", () => {
    const store = memoryStore();
    const server = "https://tableau.example.com";
    dc.rememberContent(store, server, "Sales", "dashboard-qa-insurance", {
      workbook_luid: "wb-old",
      workbook_name: "Insurance Claims (AI evaluation sample)",
      dashboard: "Insurance Claims",
      datasources: [{ luid: "ds-old", file: "silver_insurance_claims.tdsx", name: "Insurance Claims (AI evaluation sample)" }],
    });
    const stale = dc.storedContent(store, server, "Sales", "dashboard-qa-insurance");
    expect(dc.rememberedContentIsCurrent("dashboard-qa-insurance", stale, ENV)).toBe(false);
    const status = dc.contentStatus(store, server, "Sales", ENV)["dashboard-qa-insurance"]!;
    expect([status.published, status.stale]).toEqual([false, true]);
    // The current content, remembered under its own files and names, is current.
    const manifest = dc.suiteContent("dashboard-qa-insurance", ENV)!;
    dc.rememberContent(store, server, "Sales", "dashboard-qa-insurance", {
      workbook_luid: "wb-new",
      workbook_name: manifest.workbook.name,
      dashboard: manifest.workbook.dashboard,
      datasources: manifest.datasources.map((d) => ({ luid: "ds-new", file: d.file, name: d.name })),
    });
    expect(dc.rememberedContentIsCurrent("dashboard-qa-insurance", dc.storedContent(store, server, "Sales", "dashboard-qa-insurance"), ENV)).toBe(true);
    const fresh = dc.contentStatus(store, server, "Sales", ENV)["dashboard-qa-insurance"]!;
    expect([fresh.published, fresh.stale]).toEqual([true, false]);
    // A record without file details (older) still counts as current.
    dc.rememberContent(store, server, "Sales", "dashboard-qa-clv", { workbook_luid: "wb", datasources: [{ luid: "ds", display_name: "CLV" }] });
    expect(dc.rememberedContentIsCurrent("dashboard-qa-clv", dc.storedContent(store, server, "Sales", "dashboard-qa-clv"), ENV)).toBe(true);
  });
});


describe.skipIf(!CONTENT_PRESENT)("a publish the server drops is tried again (2026-10-21)", () => {
  it("retries a 5xx and a dropped connection, then succeeds; gives up after the schedule", async () => {
    // The site's front door reset the connection during the
    // Marketing Campaigns workbook upload (HTTP 503, "upstream connect error")
    // and a 1,019-question run failed before its first question.
    let workbookTries = 0;
    const fetchImpl = fakeRest([], (c) => {
      if (!c.url.pathname.endsWith("/workbooks")) return null;
      workbookTries += 1;
      if (workbookTries === 1)
        return new Response(JSON.stringify({ error: { detail: "upstream connect error or disconnect/reset before headers" } }), { status: 503 });
      if (workbookTries === 2) throw Object.assign(new Error("connection reset by peer"), { name: "ConnectionClosed" });
      return null;
    });
    const slept: number[] = [];
    const store = memoryStore();
    const ids = await dc.publishSuiteContent("dashboard-qa-insurance", { server_url: "https://t", site: "" }, {
      session: FAKE_SESSION, store, fetchImpl, sleepImpl: async (ms) => void slept.push(ms), ...ENV,
    });
    expect(ids.workbook_luid).toBe("wb-1");
    expect(workbookTries).toBe(3);
    expect(slept).toEqual([10_000, 30_000]);

    const always503 = fakeRest([], (c) =>
      c.url.pathname.endsWith("/workbooks")
        ? new Response(JSON.stringify({ error: { detail: "upstream connect error" } }), { status: 503 })
        : null,
    );
    slept.length = 0;
    const err = await dc
      .publishSuiteContent("dashboard-qa-clv", { server_url: "https://t", site: "" }, {
        session: FAKE_SESSION, store, fetchImpl: always503, sleepImpl: async (ms) => void slept.push(ms), ...ENV,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(dc.ContentPublishError);
    expect(err.message).toContain("HTTP 503");
    expect(err.message).toContain("Tried 4 times");
    expect(err.message).toContain("Resume");
    expect(slept).toEqual([10_000, 30_000, 60_000]);
  });

  it("every sample data source describes itself: a descriptive name and a note for the panel", () => {
    for (const d of dc.listDashboardDatasets(ENV)) {
      expect([d.id, d.name === d.id]).toEqual([d.id, false]);
      const full = dc.getDashboardDataset(String(d.id), ENV)!;
      expect(String(full.note || "").length).toBeGreaterThan(60);
    }
  });
});
