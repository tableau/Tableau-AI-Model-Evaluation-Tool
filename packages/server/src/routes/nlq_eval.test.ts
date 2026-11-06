/**
 * Route tests — hit representative routes via the in-process fetch handler
 * (no port binding). Uses an injected fake adapter + injected fetch so nothing
 * touches Tableau/OpenAI. Asserts status codes + response shapes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { SseState } from "@tableau-ai-eval/core";
import { MEASURED_BASELINES, PROVISIONAL_BASELINES } from "../suites/catalog.ts";
import { JobQueue } from "../worker/queue.ts";
import { createNlqEvalApp, type NlqEvalApp } from "./nlq_eval.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EmitCase,
  EvalAdapter,
  RowPayload,
  RunConfig,
  ShouldStop,
  SuitePlan,
} from "@tableau-ai-eval/core";

// A fake adapter that emits `cases` synthetic rows.
function fakeAdapter(caseIds: string[]): EvalAdapter {
  return {
    id: "fake",
    session() {
      return { close() {} };
    },
    load(): SuitePlan {
      return {
        total: caseIds.length,
        skeletons: caseIds.map((id) => ({
          test_case_id: id,
          runner: "fake",
          datasource: null,
          utterance: `u-${id}`,
          expected: {},
        })),
        conversation_ids: caseIds.map((id) => [id]),
      };
    },
    async execute(
      _plan: SuitePlan,
      _config: RunConfig,
      emitCase: EmitCase,
      shouldStop: ShouldStop,
      completedIds: Set<string>,
    ): Promise<void> {
      for (const id of caseIds) {
        if (shouldStop()) return;
        if (completedIds.has(id)) continue;
        const row: RowPayload = {
          test_case_id: id,
          runner: "fake",
          datasource: null,
          utterance: `u-${id}`,
          turn: 0,
          expected: {},
          actual: {},
          latency: 0.1,
          errors: [],
          metrics: {},
          debug_info: {},
          info: {},
        };
        await emitCase(row);
      }
    },
  };
}

let db: AiEvalDb;
let sse: SseState;
let queue: JobQueue;
let app: NlqEvalApp;
let jobIdCounter: number;

function buildApp(caseIds: string[] = ["a", "b"]): void {
  db = new AiEvalDb(":memory:");
  db.initDb();
  sse = new SseState(db);
  queue = new JobQueue({ acquireInhibitor: () => ({ release() {} }) });
  jobIdCounter = 0;
  app = createNlqEvalApp({
    db,
    sse,
    queue,
    suiteBases: { publicBase: null },
    tableauFetch: (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch,
    genJobId: () => `job${++jobIdCounter}`,
    orchestratorOverrides: {
      getAdapter: async () => fakeAdapter(caseIds),
    },
  });
  app.init();
}

async function get(path: string): Promise<Response> {
  return app.handle(new Request(`http://x${path}`));
}
async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  // Catalog-owned public suites now take the server path regardless of the
  // fake adapter named by older route fixtures. Supply an explicit test-only
  // connection for these launch fixtures; do not change saved settings.
  if (method === "POST" && path === "/nlq-eval/run" && body && typeof body === "object") {
    const cfg = body as Record<string, unknown>;
    if (cfg.suite_id === "calcs-public" && cfg.adapter === "fake") {
      body = { tableau_server: "https://tab.example.com", tableau_pat_name: "p", tableau_pat_value: "test-secret", ...cfg };
    }
  }
  return app.handle(
    new Request(`http://x${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    }),
  );
}

// These types describe the response fields exercised by the offline fixtures,
// not the complete public API. JSON parsing is the assertion boundary.
type ErrorResponse = { error: string; reason?: string; job_id?: string };
type LaunchResponse = { job_id: string; results_url: string; warnings?: string[] };
type JudgeResponse = { configured: boolean; provider?: string; api_key?: string; same_family_warning?: boolean };
type JudgeUpdateResponse = { ok: boolean; warnings: string[] };
type UiResponse = { allowSelfSigned: boolean; devMode: boolean };
type RunResponse = { job_id: string; status: string; suite_id: string; suite_label: string; batch_id: string | null; headline_scores: unknown[] };
type RunsResponse = { runs: RunResponse[]; filtered: boolean };
type ResultsResponse = {
  run: { status: string; config: Record<string, unknown> };
  results: Record<string, unknown>[];
  state: Record<string, unknown>;
};
type SuiteResponse = {
  adapter?: string;
  id: string;
  label: string;
  capability: string;
  baseline: number | null;
  baseline_provisional: boolean;
  server_routed: boolean;
  server_supported: boolean;
  server_message: string | null;
};
type SuitesResponse = {
  suites: SuiteResponse[];
  server_too_old: { release: string; message: string } | null;
};
type DashboardResponse = {
  name: string;
  title: string;
  dashboard_id: string;
  views: { name: string; outliers: number; insights: number }[];
  has_image: boolean;
  url: string | null;
  url_source: string | null;
  source: string | null;
};
type SummaryResponse = {
  job_id: string;
  status: string;
  suite_label: string;
  cases_total: number;
  cases_completed: number;
  headline_scores: { key: string; label: string; average: number | null; total_scores: number; judge_scores: number }[];
  categories: { key: string; label: string; weight: number; average: number | null }[];
  cases?: unknown;
};
type VerificationResponse = {
  ok: boolean;
  connection_ok: boolean;
  server_version: string | null;
  failed_stage: string | null;
  dashboard_qa: { enabled: boolean };
  web_authoring?: { enabled: boolean | null; message: string | null } | null;
  model_under_test: string | null;
  server_too_old: { release: string; message: string } | null;
};
type TableauResponse = {
  configured: boolean;
  server_url?: string;
  pat_name?: string;
  pat_value?: string;
  last_verified?: VerificationResponse | null;
  saved_connections?: Record<string, unknown>[];
};
type ContentResponse = {
  pinned_runs?: string[];
  dashboard_qa?: Record<string, unknown>;
};
type PublishResponse = { action: string; datasource_id: string; run_id: string; schema_version: number };

async function jsonOf<T>(r: Response): Promise<T> {
  return await r.json() as T;
}

beforeEach(() => buildApp());
afterEach(() => db.close());

describe("GET /nlq-eval/suites", () => {
  it("returns a suites array", async () => {
    const r = await get("/nlq-eval/suites");
    expect(r.status).toBe(200);
    const body = await jsonOf<SuitesResponse>(r);
    expect(Array.isArray(body.suites)).toBe(true);
  });
});

describe("GET /nlq-eval/settings/ui", () => {
  it("reports allowSelfSigned=false by default", async () => {
    const r = await get("/nlq-eval/settings/ui");
    expect(r.status).toBe(200);
    const body = await jsonOf<UiResponse>(r);
    expect(body.allowSelfSigned).toBe(false);
    expect(typeof body.devMode).toBe("boolean");
  });

  it("reports allowSelfSigned=true when the capability is enabled", async () => {
    const localDb = new AiEvalDb(":memory:");
    localDb.initDb();
    const localApp = createNlqEvalApp({
      db: localDb,
      sse: new SseState(localDb),
      queue: new JobQueue({ acquireInhibitor: () => ({ release() {} }) }),
      suiteBases: { publicBase: null },
      allowSelfSigned: true,
    });
    const r = await localApp.handle(new Request("http://x/nlq-eval/settings/ui"));
    expect(r.status).toBe(200);
    expect((await jsonOf<UiResponse>(r)).allowSelfSigned).toBe(true);
    localDb.close();
  });
});

describe("GET /nlq-eval/runs", () => {
  it("returns runs + filtered flag", async () => {
    const r = await get("/nlq-eval/runs");
    expect(r.status).toBe(200);
    const body = await jsonOf<RunsResponse>(r);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.filtered).toBe(false);
  });
});

describe("settings/judge round-trip", () => {
  it("GET unconfigured, PUT, GET masked", async () => {
    let r = await get("/nlq-eval/settings/judge");
    expect((await jsonOf<JudgeResponse>(r)).configured).toBe(false);

    r = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "openai",
      model: "gpt-4o",
      api_key: "sk-abcdef1234",
    });
    expect(r.status).toBe(200);
    expect((await jsonOf<JudgeUpdateResponse>(r)).ok).toBe(true);

    r = await get("/nlq-eval/settings/judge");
    const body = await jsonOf<JudgeResponse>(r);
    expect(body.configured).toBe(true);
    expect(body.provider).toBe("openai");
    expect(String(body.api_key)).toStartWith("****");
    expect(body.api_key).not.toContain("sk-abcdef");
  });

  it("rejects an unknown provider", async () => {
    const r = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "bogus",
      model: "x",
      api_key: "k",
    });
    expect(r.status).toBe(400);
  });

  it("masked PUT keeps the stored key", async () => {
    await send("PUT", "/nlq-eval/settings/judge", {
      provider: "openai",
      model: "gpt-4o",
      api_key: "sk-original99",
    });
    const r = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "openai",
      model: "gpt-4o",
      api_key: "****ig99",
    });
    expect(r.status).toBe(200);
    // stored key should still be the original
    const stored = db.getSetting<Record<string, unknown>>("judge")!;
    expect(stored.api_key).toBe("sk-original99");
  });

  it("a masked key does not cross providers", async () => {
    // Switching the provider with the key left as "Stored" reused the other
    // provider's key (an OpenAI key under Anthropic, 2026-10-13).
    await send("PUT", "/nlq-eval/settings/judge", {
      provider: "openai",
      model: "gpt-6-luna",
      api_key: "sk-openai-99999999",
    });
    const r = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "anthropic",
      model: "claude-opus-5-5",
      api_key: "****9999",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("for openai");
    const stored = db.getSetting<Record<string, unknown>>("judge")!;
    expect(stored.provider).toBe("openai");
    expect(stored.api_key).toBe("sk-openai-99999999");
    // A real key for the new provider goes through
    const ok = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "anthropic",
      model: "claude-opus-5-5",
      api_key: "sk-ant-11111111",
    });
    expect(ok.status).toBe(200);
  });
});

describe("same-family judge warns, never blocks", () => {
  it("PUT accepts a same-family judge with a warning; GET keeps saying so", async () => {
    let r = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "openai",
      model: "gpt-4o",
      api_key: "k",
      model_under_test_family: "openai",
    });
    expect(r.status).toBe(200);
    expect((await jsonOf<JudgeUpdateResponse>(r)).warnings[0]).toContain("own family");
    expect((await jsonOf<JudgeResponse>(await get("/nlq-eval/settings/judge"))).same_family_warning).toBe(true);
    // A judge from another family clears it.
    r = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      api_key: "k",
      model_under_test_family: "openai",
    });
    expect(r.status).toBe(200);
    expect((await jsonOf<JudgeUpdateResponse>(r)).warnings).toEqual([]);
    expect((await jsonOf<JudgeResponse>(await get("/nlq-eval/settings/judge"))).same_family_warning).toBe(false);
  });

  it("a run whose declared model shares the judge's family is accepted with a stored warning", async () => {
    await send("PUT", "/nlq-eval/settings/judge", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      api_key: "k",
    });
    const payload: Record<string, unknown> = {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      compute_nl_judge: true,
      declared_site_model: "claude-opus-4",
    };
    let r = await send("POST", "/nlq-eval/run", payload);
    expect(r.status).toBe(202);
    const body = await jsonOf<LaunchResponse>(r);
    expect(body.warnings?.[0]).toContain("own family");
    await queue.waitIdle();
    // The warning travels with the run so the results page can keep showing it.
    const stored = (await jsonOf<ResultsResponse>(await get(`/nlq-eval/results/${body.job_id}`))).run.config;
    expect(stored.judge_family_warning).toContain("own family");

    // A declared model from a different family carries no warning.
    payload.declared_site_model = "gpt-4o";
    r = await send("POST", "/nlq-eval/run", payload);
    expect(r.status).toBe(202);
    expect("warnings" in (await jsonOf<LaunchResponse>(r))).toBe(false);
    await queue.waitIdle();
  });
});

describe("suite baselines + current names", () => {
  // Measured baselines are not provisional; visualization
  // and dashboard Q&A still are, and the payload says which.
  it("every listed suite carries a baseline, measured or provisional", async () => {
    const body = await jsonOf<SuitesResponse>(await get("/nlq-eval/suites"));
    expect(body.suites.length).toBeGreaterThan(0);
    const byId = Object.fromEntries(body.suites.map((s) => [s.id, s]));
    for (const s of body.suites) {
      expect(s.baseline).not.toBeNull();
      expect(s.baseline).toBeGreaterThan(0);
      expect(s.baseline).toBeLessThanOrEqual(1);
      if (s.capability in MEASURED_BASELINES) {
        expect(s.baseline).toBe(MEASURED_BASELINES[s.capability]);
        expect(s.baseline_provisional).toBe(false);
      } else {
        expect(s.baseline).toBe(PROVISIONAL_BASELINES[s.capability]);
        expect(s.baseline_provisional).toBe(true);
      }
    }
    expect(byId["calcs-public"].baseline).toBe(0.85);
    expect(byId["color-palette"].baseline).toBe(0.88);
    // The Prep baselines were set with the Tableau Prep team on 2026-10-22.
    expect(byId["prep-intent-gen"].baseline).toBe(0.95);
    expect(byId["prep-intent-gen"].baseline_provisional).toBe(false);
    expect(byId["prep-calc-gen"].baseline).toBe(0.85);
    expect(byId["viz-authoring-public"].baseline).toBe(0.83);
    expect(byId["viz-authoring-public"].baseline_provisional).toBe(false);
  });

  it("a run stored under an old suite name is listed under the current one", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      suite_id: "calcs-public",
      suite_label: "Calc Generation — full",
    });
    const { job_id } = await jsonOf<LaunchResponse>(r);
    await queue.waitIdle();
    const runs = (await jsonOf<RunsResponse>(await get("/nlq-eval/runs"))).runs;
    const run = runs.find((x: { job_id: string }) => x.job_id === job_id);
    if (!run) throw new Error("Expected the launched run in history");
    expect(run.suite_label).toBe("Calculated fields");
    expect(Array.isArray(run.headline_scores)).toBe(true);
  });

  it("a queued run records when it was queued", async () => {
    // Hold the queue so the second job stays queued.
    let release!: () => void;
    queue.submit(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    const { job_id } = await jsonOf<LaunchResponse>(r);
    const st = db.getJobState(job_id);
    expect(st.status).toBe("queued");
    expect(st.total).toBe(2);
    const persisted = db.getRun(job_id)!;
    expect(persisted.status).toBe("queued");
    expect(persisted.total).toBe(2);
    expect(persisted.config?.llm_key).not.toBe("k");
    const skeletons = db.getEvents(job_id, 0, ["skeletons"]);
    expect(skeletons).toHaveLength(1);
    expect(JSON.parse(skeletons[0]!.payload).items).toHaveLength(2);
    expect(String(st.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    release();
    await queue.waitIdle();
  });

  it("a queued run paused before it starts stays listed with its batch", async () => {
    // Hold the queue so the run stays queued.
    let release!: () => void;
    queue.submit(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      suite_id: "calcs-public",
      batch_id: "b1",
    });
    const { job_id } = await jsonOf<LaunchResponse>(r);
    expect(db.getRun(job_id)?.status).toBe("queued");
    expect((await send("POST", `/nlq-eval/pause/${job_id}`)).status).toBe(200);
    const runs = (await jsonOf<RunsResponse>(await get("/nlq-eval/runs"))).runs;
    const run = runs.find((x: { job_id: string }) => x.job_id === job_id);
    expect(run?.status).toBe("paused");
    expect(run?.batch_id).toBe("b1");
    release();
    await queue.waitIdle();
  });

  it("a queued run can pause/resume repeatedly without executing stale queue entries", async () => {
    let release!: () => void;
    queue.submit(() => new Promise<void>((resolve) => { release = resolve; }));
    const adapter = fakeAdapter(["a", "b"]);
    let executions = 0;
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (...args) => { executions++; await execute(...args); };
    app = createNlqEvalApp({ db, sse, queue, suiteBases: { publicBase: null }, genJobId: () => "queued-resume",
      orchestratorOverrides: { getAdapter: async () => adapter } });
    const response = await send("POST", "/nlq-eval/run", {
      adapter: "fake", llm_key: "secret", gateway_url: "https://gw.example.com", batch_id: "batch",
    });
    const { job_id } = await jsonOf<LaunchResponse>(response);
    for (let i = 0; i < 2; i++) {
      expect((await send("POST", `/nlq-eval/pause/${job_id}`)).status).toBe(200);
      expect((await send("POST", `/nlq-eval/resume/${job_id}`, {})).status).toBe(202);
      expect(db.getJobControl(job_id)).toBeNull();
      expect(db.getRun(job_id)?.status).toBe("queued");
    }
    expect(executions).toBe(0);
    release();
    await queue.waitIdle();
    expect(executions).toBe(1);
    expect(db.getRun(job_id)?.status).toBe("finished");
    expect(db.getResults(job_id)).toHaveLength(2);
    expect(db.getEvents(job_id, 0, ["skeletons"])).toHaveLength(1);
  });

  it("a queued run survives recovery and resumes from its redacted persisted config", async () => {
    let release!: () => void;
    queue.submit(() => new Promise<void>((resolve) => { release = resolve; }));
    const response = await send("POST", "/nlq-eval/run", {
      adapter: "fake", llm_key: "secret", gateway_url: "https://gw.example.com", batch_id: "batch",
    });
    const { job_id } = await jsonOf<LaunchResponse>(response);
    // New app has no process-local config cache. init() recovers queued runs.
    const restartedQueue = new JobQueue({ acquireInhibitor: () => ({ release() {} }) });
    const restarted = createNlqEvalApp({ db, sse, queue: restartedQueue, suiteBases: { publicBase: null },
      orchestratorOverrides: { getAdapter: async () => fakeAdapter(["a", "b"]) } });
    restarted.init();
    expect(db.getRun(job_id)?.status).toBe("paused");
    const request = (body: unknown) => new Request(`http://x/nlq-eval/resume/${job_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await restarted.handle(request({}))).status).toBe(409);
    // Drain the old queue while paused, as if its pending closures died on restart.
    release();
    await queue.waitIdle();
    expect((await restarted.handle(request({ llm_key: "replacement-secret" }))).status).toBe(202);
    await restartedQueue.waitIdle();
    expect(db.getRun(job_id)?.status).toBe("finished");
    expect(db.getRun(job_id)?.config?.batch_id).toBe("batch");
  });

  it("a legacy queued job without a runs row resumes using its in-memory config", async () => {
    let release!: () => void;
    queue.submit(() => new Promise<void>((resolve) => { release = resolve; }));
    const response = await send("POST", "/nlq-eval/run", {
      adapter: "fake", llm_key: "secret", gateway_url: "https://gw.example.com",
    });
    const { job_id } = await jsonOf<LaunchResponse>(response);
    // Emulate the old launch behavior without discarding the config cache.
    db.db.query("DELETE FROM runs WHERE job_id = ?").run(job_id);
    expect((await send("POST", `/nlq-eval/pause/${job_id}`)).status).toBe(200);
    expect((await send("POST", `/nlq-eval/resume/${job_id}`, {})).status).toBe(202);
    release();
    await queue.waitIdle();
    expect(db.getRun(job_id)?.status).toBe("finished");
  });

  it("pausing and resuming a batch act on every suite, in launch order", async () => {
    // Hold the queue so both launches stay queued.
    let release!: () => void;
    queue.submit(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const payload = {
      org_id: "o", llm_key: "k", gateway_url: "https://gw.example.com", adapter: "fake",
      suite_id: "calcs-public", batch_id: "b-all",
    };
    const first = (await jsonOf<LaunchResponse>(await send("POST", "/nlq-eval/run", payload))).job_id;
    const second = (await jsonOf<LaunchResponse>(await send("POST", "/nlq-eval/run", payload))).job_id;
    const paused = await send("POST", "/nlq-eval/batches/b-all/pause");
    expect(paused.status).toBe(200);
    expect(await jsonOf<{ paused: number }>(paused)).toMatchObject({ paused: 2 });
    expect(db.getRun(first)?.status).toBe("paused");
    expect(db.getRun(second)?.status).toBe("paused");
    // Nothing left to pause.
    expect((await send("POST", "/nlq-eval/batches/b-all/pause")).status).toBe(409);
    const resumed = await send("POST", "/nlq-eval/batches/b-all/resume", {});
    expect(resumed.status).toBe(202);
    expect(await jsonOf<{ resumed: number; skipped: number }>(resumed)).toMatchObject({ resumed: 2, skipped: 0 });
    expect(db.getRun(first)?.status).toBe("queued");
    expect(db.getRun(second)?.status).toBe("queued");
    // Nothing left to resume.
    expect((await send("POST", "/nlq-eval/batches/b-all/resume", {})).status).toBe(409);
    release();
    await queue.waitIdle();
    expect(db.getRun(first)?.status).toBe("finished");
    expect(db.getRun(second)?.status).toBe("finished");
  });

  it("a queued run cancelled before it starts stays listed with its batch", async () => {
    let release!: () => void;
    queue.submit(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      suite_id: "calcs-public",
      batch_id: "b2",
    });
    const { job_id } = await jsonOf<LaunchResponse>(r);
    expect((await send("POST", `/nlq-eval/cancel/${job_id}`)).status).toBe(200);
    const runs = (await jsonOf<RunsResponse>(await get("/nlq-eval/runs"))).runs;
    const run = runs.find((x: { job_id: string }) => x.job_id === job_id);
    expect(run?.status).toBe("cancelled");
    expect(run?.batch_id).toBe("b2");
    release();
    await queue.waitIdle();
  });

  it("a paused run past the limit is not listed again from its job state", async () => {
    db.createRun({ job_id: "old", org_id: "o", user_id: "", ai_feature: "", runner_name: "", config: { suite_id: "calcs-public" } });
    db.updateRunStatus("old", "paused");
    db.patchJobState("old", { status: "paused" });
    db.createRun({ job_id: "new", org_id: "o", user_id: "", ai_feature: "", runner_name: "", config: { suite_id: "calcs-public" } });
    const runs = (await jsonOf<RunsResponse>(await get("/nlq-eval/runs?limit=1"))).runs;
    expect(runs.map((x) => x.job_id)).toEqual(["new"]);
  });
});

describe("GET /nlq-eval/dashboards/<job>/<case>[/image]", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function seedRun(jobId: string, withImage: boolean, withUrl = false, folderIn?: string): string {
    const folder = folderIn ?? mkdtempSync(join(tmpdir(), "dash-route-"));
    if (!folderIn) {
      writeFileSync(
      join(folder, "one.json"),
      JSON.stringify({
        id: "abc123",
        info: withUrl
          ? {
              source_url: "https://public.tableau.com/example",
              source: "Tableau Public",
              title: "Triathlon Splits (Splits Overview)",
            }
          : null,
        inputs: [
          {
            arguments: {
              dashboardName: "Splits Overview",
              dashboardId: "SplitsOverview",
              views: [{ name: "V", artifacts: [{ artifactType: "OUTLIERS", artifact: "{}" }] }],
              dashboardArtifacts: withImage
                ? [{ artifactType: "IMAGE", artifact: Buffer.from(PNG).toString("base64") }]
                : [],
            },
          },
        ],
      }),
    );
    }
    db.createRun({
      job_id: jobId,
      org_id: "o",
      user_id: "u",
      ai_feature: "dashboard-narratives",
      runner_name: "dashboard-viz-narrative-config",
      config: { test_path: folder, suite_id: "dashboard-narratives" },
    });
    return folder;
  }

  it("serves the panel and the picture; anything else is a plain 404", async () => {
    seedRun("dn1", true, true);
    let r = await get("/nlq-eval/dashboards/dn1/abc123");
    expect(r.status).toBe(200);
    const info = await jsonOf<DashboardResponse>(r);
    expect(info.name).toBe("Splits Overview");
    expect(info.has_image).toBe(true);
    expect(info.views).toEqual([{ name: "V", outliers: 1, insights: 0 }]);
    expect(info.url).toBe("https://public.tableau.com/example");
    expect(info.source).toBe("Tableau Public");
    expect(info.url_source).toBe("case");
    expect(info.dashboard_id).toBe("SplitsOverview");
    expect(info.title).toBe("Triathlon Splits (Splits Overview)");

    // The run's dashboards at once, for the results table: the
    // descriptive name when the case carries one, else the dashboard's own.
    expect((await jsonOf<{ dashboards: Record<string, { name: string; title: string }> }>(await get("/nlq-eval/dashboards/dn1"))).dashboards).toEqual({
      abc123: { name: "Splits Overview", title: "Triathlon Splits (Splits Overview)" },
    });
    expect(await jsonOf<{ dashboards: Record<string, { name: string; title: string }> }>(await get("/nlq-eval/dashboards/missing"))).toEqual({ dashboards: {} });

    r = await get("/nlq-eval/dashboards/dn1/abc123/image");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect(r.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual(Array.from(PNG));

    // Unknown case, unknown run: a plain 404, never a file outside the run's folder.
    expect((await get("/nlq-eval/dashboards/dn1/nope")).status).toBe(404);
    expect((await get("/nlq-eval/dashboards/dn1/..%2F..%2Fetc/image")).status).toBe(404);
    r = await get("/nlq-eval/dashboards/missing/abc123");
    expect(r.status).toBe(404);
    expect((await jsonOf<ErrorResponse>(r)).error).toContain("not on this machine");
  });

  it("a case without a picture says so", async () => {
    seedRun("dn2", false);
    expect((await jsonOf<DashboardResponse>(await get("/nlq-eval/dashboards/dn2/abc123"))).has_image).toBe(false);
    const r = await get("/nlq-eval/dashboards/dn2/abc123/image");
    expect(r.status).toBe(404);
    expect((await jsonOf<ErrorResponse>(r)).error).toContain("no picture");
  });

  it("an admin can say where a dashboard is published", async () => {
    const folder = seedRun("dn3", true);
    const info = await jsonOf<DashboardResponse>(await get("/nlq-eval/dashboards/dn3/abc123"));
    expect(info.url).toBeNull();
    expect(info.url_source).toBeNull();
    expect(info.title).toBe("Splits Overview"); // no info.title: the dashboard's own name

    const bad = await send("PUT", "/nlq-eval/dashboards/dn3/abc123/location", { url: "Splits Overview" });
    expect(bad.status).toBe(400);
    expect((await jsonOf<ErrorResponse>(bad)).error).toContain("http");

    const saved = await send("PUT", "/nlq-eval/dashboards/dn3/abc123/location", {
      url: " https://tableau.example.com/#/site/s/views/Splits/Overview ",
    });
    expect(saved.status).toBe(200);
    const savedBody = await jsonOf<DashboardResponse>(saved);
    expect(savedBody.url).toBe("https://tableau.example.com/#/site/s/views/Splits/Overview");
    expect(savedBody.url_source).toBe("saved");
    expect(db.getSetting<Record<string, string>>("dashboard_locations")).toEqual({
      SplitsOverview: "https://tableau.example.com/#/site/s/views/Splits/Overview",
    });

    // Another run of the same dashboard sees the saved address.
    seedRun("dn4", true, false, folder);
    expect((await jsonOf<DashboardResponse>(await get("/nlq-eval/dashboards/dn4/abc123"))).url_source).toBe("saved");

    const forgotten = await send("PUT", "/nlq-eval/dashboards/dn3/abc123/location", { url: "" });
    expect(forgotten.status).toBe(200);
    expect((await jsonOf<DashboardResponse>(forgotten)).url).toBeNull();
    expect(db.getSetting<Record<string, string>>("dashboard_locations")).toEqual({});

    expect(
      (await send("PUT", "/nlq-eval/dashboards/dn3/nope/location", { url: "https://x.example" })).status,
    ).toBe(404);
  });

  it("the case's own address wins over a saved one", async () => {
    seedRun("dn5", true, true);
    db.setSetting("dashboard_locations", { SplitsOverview: "https://elsewhere.example/views/a/b" });
    const info = await jsonOf<DashboardResponse>(await get("/nlq-eval/dashboards/dn5/abc123"));
    expect(info.url).toBe("https://public.tableau.com/example");
    expect(info.url_source).toBe("case");
  });
});

describe("GET /nlq-eval/summary/<job_id>", () => {
  it("404 for an unknown job", async () => {
    const r = await get("/nlq-eval/summary/nope");
    expect(r.status).toBe(404);
  });

  it("returns the run's headline numbers without its cases", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      suite_id: "calcs-public",
    });
    const { job_id } = await jsonOf<LaunchResponse>(r);
    await queue.waitIdle();
    db.insertTestMetrics(job_id, "a", "calculatedFieldFormula", [
      { metric_name: "calcValidity", score: 0.5 },
    ]);
    const res = await get(`/nlq-eval/summary/${job_id}`);
    expect(res.status).toBe(200);
    const body = await jsonOf<SummaryResponse>(res);
    expect(body.job_id).toBe(job_id);
    expect(body.status).toBe("Completed");
    expect(body.suite_label).toBe("Calculated fields");
    expect(body.cases_total).toBe(2);
    expect(body.cases_completed).toBe(2);
    expect(body.headline_scores).toEqual([
      { key: "calc", label: "Calculated fields", average: 0.5, total_scores: 1, judge_scores: 0 },
    ]);
    expect(body.categories[0]).toEqual({
      key: "calc",
      label: "Calculated fields",
      weight: 13,
      average: 0.5,
    });
    expect(body.cases).toBeUndefined();
  });
});

describe("settings/tableau round-trip", () => {
  it("PUT then GET masks the PAT", async () => {
    let r = await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://tab.example.com",
      site: "mysite",
      pat_name: "pat1",
      pat_value: "secretpatvalue",
    });
    expect(r.status).toBe(200);
    r = await get("/nlq-eval/settings/tableau");
    const body = await jsonOf<TableauResponse>(r);
    expect(body.configured).toBe(true);
    expect(body.server_url).toBe("https://tab.example.com");
    expect(String(body.pat_value)).toStartWith("****");
  });

  it("rejects a schemeless server_url", async () => {
    const r = await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "tab.example.com",
      pat_name: "p",
      pat_value: "v",
    });
    expect(r.status).toBe(400);
  });
});

describe("saved connections", () => {
  const putConnection = (overrides: Record<string, unknown> = {}) =>
    send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://tab.example.com",
      site: "MySite",
      pat_name: "eval-pat",
      pat_value: "secret-pat-value-123",
      verify_tls: false,
      ...overrides,
    });

  it("keeps every saved connection, one active", async () => {
    await putConnection();
    await putConnection({
      server_url: "https://other.example.com",
      site: "",
      pat_name: "other-pat",
      pat_value: "other-secret",
    });
    const body = await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"));
    expect(body.server_url).toBe("https://other.example.com");
    const saved = body.saved_connections as Array<Record<string, unknown>>;
    expect(saved.map((c) => [c.server_url, c.site, c.active])).toEqual([
      ["https://tab.example.com", "MySite", false],
      ["https://other.example.com", "", true],
    ]);
    expect(saved.every((c) => String(c.pat_value).startsWith("****"))).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret-pat-value");
    // Saving the same server and site again replaces the entry.
    await putConnection({ pat_name: "eval-pat-2" });
    const list = (await jsonOf<{ connections: Record<string, unknown>[] }>(await get("/nlq-eval/settings/tableau/connections"))).connections as Array<
      Record<string, unknown>
    >;
    expect(list.map((c) => [c.server_url, c.pat_name])).toEqual([
      ["https://other.example.com", "other-pat"],
      ["https://tab.example.com", "eval-pat-2"],
    ]);
  });

  it("activating a saved connection switches the tool and restores its verification", async () => {
    const okFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const u = typeof input === "string" ? input : input.toString();
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (u.includes("serverinfo")) return j({ serverInfo: { productVersion: { value: "2026.3.0" } } });
      if (u.includes("auth/signin")) return j({ credentials: { token: "t", site: { id: "s1" } } });
      if (u.includes("/sites/s1"))
        return j({
          site: { siteSettings: [{ key: "generativeAiVizAndCalcGenerationModel", value: "claude-sonnet-5" }] },
        });
      if (u.includes("/cabu/conversations")) return j({ errorMsg: "workbook not found" }, 400);
      return j({ generations: [{ text: "pong" }] });
    }) as unknown as typeof fetch;
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: okFetch,
      genJobId: () => `jobsc${++jobIdCounter}`,
    });
    app.init();

    await putConnection();
    expect((await send("POST", "/nlq-eval/preflight", {})).status).toBe(200);
    const first = await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"));
    expect(first.last_verified?.ok).toBe(true);
    expect(first.last_verified?.dashboard_qa.enabled).toBe(true);

    await putConnection({ server_url: "https://other.example.com", site: "Two", pat_name: "p2", pat_value: "s2" });
    expect((await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"))).last_verified).toBeNull();

    const r = await send("POST", "/nlq-eval/settings/tableau/activate", {
      server_url: "https://tab.example.com/",
      site: "MySite",
    });
    expect(r.status).toBe(200);
    const back = await jsonOf<TableauResponse>(r);
    expect(back.server_url).toBe("https://tab.example.com");
    expect(back.pat_name).toBe("eval-pat");
    expect(back.last_verified?.ok).toBe(true);
    expect(back.last_verified?.model_under_test).toBe("claude-sonnet-5");
    expect(db.getSetting<Record<string, unknown>>("tableau")!.pat_value).toBe("secret-pat-value-123");
    expect((back.saved_connections as Array<{ active: boolean }>).map((c) => c.active)).toEqual([true, false]);

    const missing = await send("POST", "/nlq-eval/settings/tableau/activate", {
      server_url: "https://nowhere",
      site: "",
    });
    expect(missing.status).toBe(404);
    expect((await jsonOf<ErrorResponse>(missing)).reason).toBe("unknown_connection");
  });

  it("forgets a saved connection; forgetting the active one leaves the tool unconnected", async () => {
    await putConnection();
    await putConnection({ server_url: "https://other.example.com", site: "Two" });
    const r = await send("DELETE", "/nlq-eval/settings/tableau/connections", {
      server_url: "https://tab.example.com",
      site: "MySite",
    });
    expect(r.status).toBe(200);
    expect(((await jsonOf<{ connections: Record<string, unknown>[] }>(r)).connections as Array<{ server_url: string }>).map((c) => c.server_url)).toEqual([
      "https://other.example.com",
    ]);
    expect((await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"))).server_url).toBe("https://other.example.com");
    await send("DELETE", "/nlq-eval/settings/tableau/connections", {
      server_url: "https://other.example.com",
      site: "Two",
    });
    expect((await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"))).configured).toBe(false);
    const again = await send("DELETE", "/nlq-eval/settings/tableau/connections", {
      server_url: "https://other.example.com",
      site: "Two",
    });
    expect(again.status).toBe(404);
  });

  it("lists a connection saved before the list existed", async () => {
    db.setSetting("tableau", {
      server_url: "https://old.example.com",
      site: "S",
      pat_name: "p",
      pat_value: "secret",
    });
    db.setSetting("tableau_connections", []);
    const body = await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"));
    expect(
      (body.saved_connections as Array<Record<string, unknown>>).map((c) => [c.server_url, c.active]),
    ).toEqual([["https://old.example.com", true]]);
    expect(JSON.stringify(body)).not.toContain('"secret"');
  });
});

describe("settings/content round-trip", () => {
  it("GET default, PUT pinned runs", async () => {
    let r = await get("/nlq-eval/settings/content");
    let body = await jsonOf<ContentResponse>(r);
    expect(body.pinned_runs).toEqual([]);
    r = await send("PUT", "/nlq-eval/settings/content", { pinned_runs: ["example-run"] });
    expect(r.status).toBe(200);
    r = await get("/nlq-eval/settings/content");
    body = await jsonOf<ContentResponse>(r);
    expect(body.pinned_runs).toEqual(["example-run"]);
  });

  it("custom evaluations are included in run history", async () => {
    db.createRun({
      job_id: "dnrun1",
      org_id: "o",
      user_id: "u",
      ai_feature: "dashboard-narratives",
      runner_name: "dashboard-viz-narrative-config",
      config: { suite_id: "custom-suite" },
    });
    const listed = async () =>
      new Set((await jsonOf<RunsResponse>(await get("/nlq-eval/runs"))).runs.map((x) => x.job_id));
    expect((await listed()).has("dnrun1")).toBe(true);
  });
});

describe("POST /nlq-eval/run + status/results", () => {
  it("launches, runs to finished, exposes status + results", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    expect(r.status).toBe(202);
    const { job_id } = await jsonOf<LaunchResponse>(r);
    expect(job_id).toBe("job1");

    await queue.waitIdle();

    const st = await get(`/nlq-eval/status/${job_id}`);
    expect(st.status).toBe(200);
    const stBody = await jsonOf<{ status: string; completed: number }>(st);
    expect(stBody.status).toBe("finished");
    expect(stBody.completed).toBe(2);

    const res = await get(`/nlq-eval/results/${job_id}`);
    expect(res.status).toBe(200);
    const resBody = await jsonOf<ResultsResponse>(res);
    expect(resBody.run.status).toBe("finished");
    expect(resBody.results.length).toBe(2);
    expect(resBody.state).toBeDefined();
  });

  it("rejects a run missing credentials", async () => {
    const r = await send("POST", "/nlq-eval/run", { org_id: "o" });
    expect(r.status).toBe(400);
  });

  it("fills suite_label from a known suite_id when the caller sends none", async () => {
    // An API caller that sends only suite_id still gets a customer-facing name
    // on the run, so the results tabs never show the internal runner id.
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      suite_id: "calcs-public",
    });
    expect(r.status).toBe(202);
    const { job_id } = await jsonOf<LaunchResponse>(r);
    await queue.waitIdle();
    expect(db.getJobState(job_id).suite_label).toBe("Calculated fields");
  });

  it("keeps an explicit suite_label and leaves an unknown suite_id's label empty", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      suite_id: "no-such-suite",
      suite_label: "My Custom Label",
    });
    expect(r.status).toBe(202);
    const { job_id } = await jsonOf<LaunchResponse>(r);
    await queue.waitIdle();
    expect(db.getJobState(job_id).suite_label).toBe("My Custom Label");
  });

  it("rejects a schemeless gateway_url", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "gw.example.com",
    });
    expect(r.status).toBe(400);
  });

  it("409 when compute_nl_judge without a judge", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      compute_nl_judge: true,
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("Set up an evaluator model");
  });
});

describe("CES-mode run field contract (Tableau is the gateway)", () => {
  async function putConnection(): Promise<void> {
    await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://tab.example.com",
      site: "",
      pat_name: "p",
      pat_value: "secretpatvalue",
      verify_tls: true,
    });
  }

  it("a CES run does not need llm_key/gateway_url and gets the bridge placeholder", async () => {
    await putConnection();
    // Capture the config the orchestrator runs with via a custom adapter.
    let seen: Record<string, unknown> | undefined;
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      genJobId: () => `jobces${++jobIdCounter}`,
      orchestratorOverrides: {
        getAdapter: async (cfg: Record<string, unknown>) => {
          // Snapshot: the CES bridge mutates the live config (sets gateway_url)
          // right after this, so capture a copy to assert the route-layer state.
          seen = { ...cfg };
          return fakeAdapter([]);
        },
      },
    });
    app.init();
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "local",
      runner: "calc-prompt",
      generations_mode: "ces",
    });
    expect(r.status).toBe(202);
    await queue.waitIdle();
    expect(seen).toBeDefined();
    expect(seen!.generations_mode).toBe("ces");
    expect(seen!.tableau_server).toBe("https://tab.example.com");
    expect(seen!.llm_key).toBe("local-ces-bridge");
    expect(seen!.gateway_url).toBeUndefined();
  });

  it("a CES run without a saved Tableau connection asks for Settings", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "local",
      runner: "calc-prompt",
      generations_mode: "ces",
    });
    expect(r.status).toBe(400);
    const err = String((await jsonOf<ErrorResponse>(r)).error);
    expect(err).toContain("Connect to Tableau Server first");
  });

  it("a palette run needs the stored connection and nothing else", async () => {
    // A palette run talks to Tableau Server, so it is launched like every
    // customer-path run: from the stored connection, with no gateway address
    // or key, whether or not the request says generations_mode.
    const launch = {
      adapter: "palettes",
      runner: "color-palettes-server",
      suite_id: "color-palette",
      ai_feature: "palettes",
    };
    let r = await send("POST", "/nlq-eval/run", launch);
    expect(r.status).toBe(400);
    const err = String((await jsonOf<ErrorResponse>(r)).error);
    expect(err).toContain("Connect to Tableau Server first");
    expect(err).not.toContain("llm_key");

    await putConnection();
    let seen: Record<string, unknown> | undefined;
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      genJobId: () => `jobpal${++jobIdCounter}`,
      orchestratorOverrides: {
        getAdapter: async (cfg: Record<string, unknown>) => {
          seen = { ...cfg };
          return fakeAdapter([]);
        },
      },
    });
    app.init();
    r = await send("POST", "/nlq-eval/run", launch);
    expect(r.status).toBe(202);
    await queue.waitIdle();
    expect(seen!.adapter).toBe("palettes");
    expect(seen!.tableau_server).toBe("https://tab.example.com");
    expect(seen!.ces_url).toBe("https://tab.example.com/content-exploration");
  });

  it("dashboard questions remember the workbook ids per server and site", async () => {
    // Asked for once; a run without them (Evaluate all, the results page)
    // reuses the ids of the last run on the same server and site, and says
    // what to do when there are none. Ids saved for another site are never reused.
    await putConnection();
    const seen: Record<string, unknown>[] = [];
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      genJobId: () => `jobdqa${++jobIdCounter}`,
      orchestratorOverrides: {
        getAdapter: async (cfg: Record<string, unknown>) => {
          seen.push({ ...cfg });
          return fakeAdapter([]);
        },
      },
    });
    app.init();
    // A custom CABU suite takes ids from the request and remembers them.
    const run = { runner: "cabu-dashboard-qa", adapter: "cabu", suite_id: "cabu-multi-turn-smoke" };

    const first = await send("POST", "/nlq-eval/run", run);
    expect(first.status).toBe(400);
    const firstBody = await jsonOf<ErrorResponse>(first);
    expect(firstBody.reason).toBe("dashboard_content_missing");
    expect(firstBody.error).toContain("publish the sample content or enter the ids");
    expect((await jsonOf<ContentResponse>(await get("/nlq-eval/settings/content"))).dashboard_qa).toEqual({});

    const given = await send("POST", "/nlq-eval/run", {
      ...run,
      workbook_luid: "wb-1",
      datasource_luid: "ds-1",
    });
    expect(given.status).toBe(202);
    expect((await jsonOf<ContentResponse>(await get("/nlq-eval/settings/content"))).dashboard_qa).toEqual({
      workbook_luid: "wb-1",
      datasource_luid: "ds-1",
    });

    const reused = await send("POST", "/nlq-eval/run", run);
    expect(reused.status).toBe(202);
    await queue.waitIdle();
    expect(seen.map((c) => [c.workbook_luid, c.datasource_luid])).toEqual([
      ["wb-1", "ds-1"],
      ["wb-1", "ds-1"],
      ["wb-1", "ds-1"],
      ["wb-1", "ds-1"],
    ]);

    // PLACEHOLDER (the suite file's own value) is no id.
    expect(
      (await send("POST", "/nlq-eval/run", { ...run, workbook_luid: "PLACEHOLDER", datasource_luid: "PLACEHOLDER" }))
        .status,
    ).toBe(202);
    await queue.waitIdle();
    expect(seen[2]!.workbook_luid).toBe("wb-1");

    await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://tab.example.com",
      site: "Other",
      pat_name: "p",
      pat_value: "secretpatvalue",
      verify_tls: true,
    });
    expect((await jsonOf<ContentResponse>(await get("/nlq-eval/settings/content"))).dashboard_qa).toEqual({});
    expect((await send("POST", "/nlq-eval/run", run)).status).toBe(400);
  });

  it("a direct run still requires llm_key + gateway_url", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      org_id: "local",
      runner: "calc-prompt",
    });
    expect(r.status).toBe(400);
    const err = String((await jsonOf<ErrorResponse>(r)).error);
    expect(err).toContain("llm_key");
    expect(err).toContain("gateway_url");
  });

  it("a CES resume restores the connection and does not 409 on missing gateway creds", async () => {
    await putConnection();
    // Seed a paused CES run whose stored config lacks llm_key/gateway_url.
    db.patchJobState("jces", { status: "started" });
    db.createRun({
      job_id: "jces",
      org_id: "local",
      user_id: "",
      ai_feature: "",
      runner_name: "calc-prompt",
      config: { org_id: "local", runner: "calc-prompt", generations_mode: "ces" },
    });
    db.updateRunStatus("jces", "started");
    let r = await send("POST", "/nlq-eval/pause/jces");
    expect(r.status).toBe(200);
    // Resume with an empty body: mergeTableauSettings must restore server+PAT
    // from the stored connection, and the CES path must not require gateway creds.
    r = await send("POST", "/nlq-eval/resume/jces", {});
    expect(r.status).toBe(202);
    expect(db.getJobControl("jces")).toBe(null);
    await queue.waitIdle();
  });

  it("resume deletes the leftover 'done' event the pause logged (bug bash S2-1)", async () => {
    await putConnection();
    db.patchJobState("jrd", { status: "started" });
    db.createRun({
      job_id: "jrd",
      org_id: "local",
      user_id: "",
      ai_feature: "",
      runner_name: "calc-prompt",
      config: { org_id: "local", runner: "calc-prompt", generations_mode: "ces" },
    });
    db.updateRunStatus("jrd", "started");
    let r = await send("POST", "/nlq-eval/pause/jrd");
    expect(r.status).toBe(200);
    // The pause logged a durable done{status:paused}.
    let dones = sse.getEvents("jrd").filter((e) => e.type === "done");
    expect(dones.length).toBe(1);
    expect(JSON.parse(dones[0]!.payload).status).toBe("paused");
    // Resume drops it before re-queuing, so later connections don't replay it.
    r = await send("POST", "/nlq-eval/resume/jrd", {});
    expect(r.status).toBe(202);
    dones = sse.getEvents("jrd").filter((e) => e.type === "done");
    expect(dones.length).toBe(0);
    await queue.waitIdle();
  });
});

describe("cancel / pause / resume flags", () => {
  it("pause aborts in-flight work, releases the next suite, and retries interrupted cases on resume", async () => {
    const adapter = fakeAdapter(["a", "b"]);
    const execute = adapter.execute.bind(adapter);
    let entered!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    let aborted = false;
    adapter.execute = async (plan, config, emit, stop, completed) => {
      if (config.job_id === "job1" && !config._resumed) {
        // Complete one case, then simulate a network request that only ends
        // when aborted. A boundary-only pause would block the queue forever.
        let firstComplete = false;
        await execute(plan, config, async row => {
          await emit(row);
          firstComplete = true;
        }, () => firstComplete ? "pause" : stop(), completed);
        plan.case_started?.("b");
        const signal = config._run_signal as AbortSignal;
        entered();
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true }));
      } else {
        await execute(plan, config, emit, stop, completed);
      }
    };
    app = createNlqEvalApp({ db, sse, queue, genJobId: () => `job${++jobIdCounter}`,
      orchestratorOverrides: { getAdapter: async () => adapter } });
    const payload = { adapter: "fake", llm_key: "k", gateway_url: "https://gw.example.com" };
    await send("POST", "/nlq-eval/run", payload);
    await inFlight;
    await send("POST", "/nlq-eval/run", payload);
    expect((await send("POST", "/nlq-eval/pause/job1")).status).toBe(200);
    await queue.waitIdle(1000);
    expect(aborted).toBe(true);
    expect(queue.pendingCount()).toBe(0);
    expect(db.getRun("job2")?.status).toBe("finished");
    expect(db.getRun("job1")?.status).toBe("paused");
    expect(db.getRun("job1")?.completed).toBe(1);
    expect(db.getJobState("job1").running_case_ids).toEqual([]);
    expect(db.getResults("job1").map(row => row.test_case_id)).toEqual(["a"]);
    expect(db.getErrors("job1")).toEqual([]);
    expect((await send("POST", "/nlq-eval/resume/job1", {})).status).toBe(202);
    await queue.waitIdle();
    expect(db.getRun("job1")?.status).toBe("finished");
    expect(db.getResults("job1")).toHaveLength(2);
  });

  it("cancel sets the control flag + marks cancelled", async () => {
    // seed a queued job via state + runs
    db.patchJobState("jx", { status: "started" });
    db.createRun({
      job_id: "jx",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.updateRunStatus("jx", "started");
    const r = await send("POST", "/nlq-eval/cancel/jx");
    expect(r.status).toBe(200);
    expect(db.getJobControl("jx")).toBe("cancel");
    expect((db.getRun("jx") as Record<string, unknown>).status).toBe("cancelled");
    // done event emitted
    const evs = sse.getEvents("jx").map((e) => JSON.parse(e.payload));
    expect(evs.at(-1).type).toBe("done");
    expect(evs.at(-1).status).toBe("cancelled");
  });

  it("pause only a running job; resume needs creds", async () => {
    db.patchJobState("jp", { status: "started" });
    db.createRun({
      job_id: "jp",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.updateRunStatus("jp", "started");
    let r = await send("POST", "/nlq-eval/pause/jp");
    expect(r.status).toBe(200);
    expect(db.getJobControl("jp")).toBe("pause");
    expect((db.getRun("jp") as Record<string, unknown>).status).toBe("paused");

    // resume without creds in body/config -> 409
    r = await send("POST", "/nlq-eval/resume/jp", {});
    expect(r.status).toBe(409);

    // resume with creds -> 202 and clears control
    r = await send("POST", "/nlq-eval/resume/jp", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
    });
    expect(r.status).toBe(202);
    expect(db.getJobControl("jp")).toBe(null);
    await queue.waitIdle();
  });

  it("pausing a finished job returns 409", async () => {
    db.createRun({
      job_id: "jf",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.updateRunStatus("jf", "finished");
    db.patchJobState("jf", { status: "finished" });
    const r = await send("POST", "/nlq-eval/pause/jf");
    expect(r.status).toBe(409);
  });
});

describe("DELETE /nlq-eval/results/<job_id>", () => {
  it("cancel during preparation permits immediate deletion and releases the next queued run", async () => {
    const adapter = fakeAdapter(["a"]);
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const load = adapter.load.bind(adapter);
    adapter.load = async config => {
      if (config.job_id === "job1") {
        entered();
        const signal = config._run_signal as AbortSignal;
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return load(config);
    };
    app = createNlqEvalApp({ db, sse, queue, genJobId: () => `job${++jobIdCounter}`,
      orchestratorOverrides: { getAdapter: async () => adapter } });
    const payload = { adapter: "fake", org_id: "o", llm_key: "k", gateway_url: "https://gw.example.com" };
    await send("POST", "/nlq-eval/run", payload);
    await preparing;
    await send("POST", "/nlq-eval/run", payload);
    expect((await send("POST", "/nlq-eval/cancel/job1")).status).toBe(200);
    expect((await send("DELETE", "/nlq-eval/results/job1")).status).toBe(200);
    await queue.waitIdle();
    expect(db.getRun("job1")).toBeNull();
    expect(db.getJobState("job1")).toEqual({});
    expect(db.getRun("job2")?.status).toBe("finished");
  });

  it("deletes a finished run", async () => {
    db.createRun({
      job_id: "jd",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    // Mark inactive (finished) — an in-flight run must be cancelled first.
    db.updateRunStatus("jd", "finished");
    db.patchJobState("jd", { status: "finished" });
    let r = await send("DELETE", "/nlq-eval/results/jd");
    expect(r.status).toBe(200);
    r = await send("DELETE", "/nlq-eval/results/jd");
    expect(r.status).toBe(404);
  });

  it("409 when deleting an in-flight (running) run", async () => {
    // A queued/started/running run must not be deletable — deleting it could
    // orphan rows or let the queued closure resurrect the run after delete.
    db.createRun({
      job_id: "jr",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.updateRunStatus("jr", "started");
    db.patchJobState("jr", { status: "started" });
    const r = await send("DELETE", "/nlq-eval/results/jr");
    expect(r.status).toBe(409);
    // The run row must still exist (not deleted).
    expect(db.getRun("jr")).not.toBeNull();
  });

  it("409 when deleting a live run started via POST /run (not yet drained)", async () => {
    // Start a run but do NOT await queue.waitIdle(); force it into a
    // queued/started state, then attempt delete.
    await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    // Ensure the run row reflects an active state at delete time.
    db.updateRunStatus("job1", "started");
    db.patchJobState("job1", { status: "started" });
    const r = await send("DELETE", "/nlq-eval/results/job1");
    expect(r.status).toBe(409);
    await queue.waitIdle();
  });

  it("404 when deleting an unknown run", async () => {
    const r = await send("DELETE", "/nlq-eval/results/nope");
    expect(r.status).toBe(404);
  });
});

describe("GET /nlq-eval/status unknown job", () => {
  it("404", async () => {
    const r = await get("/nlq-eval/status/nope");
    expect(r.status).toBe(404);
  });
});

describe("GET /nlq-eval/export", () => {
  it("json export for a finished run, 404 for unknown", async () => {
    await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    await queue.waitIdle();
    const r = await get("/nlq-eval/export/job1");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Disposition")).toContain(".json");

    const r2 = await get("/nlq-eval/export/nope");
    expect(r2.status).toBe(404);
  });
});

describe("GET /nlq-eval/datasets", () => {
  it("lists the pack's datasets and serves one; 404 for an unknown id or a path", async () => {
    const localApp = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: join(import.meta.dir, "..", "..", "..", "..", "public-suites") },
    });
    const list = (await (await localApp.handle(new Request("http://x/nlq-eval/datasets"))).json()) as {
      datasets: Array<{ id: string }>;
    };
    expect(list.datasets.some((d) => d.id === "public-account-360")).toBe(true);
    const one = await localApp.handle(new Request("http://x/nlq-eval/datasets/public-account-360"));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { fields: unknown[] }).fields.length).toBe(67);
    for (const bad of ["no-such-dataset", "..%2F..%2Fpackages%2Fcore%2Fsrc%2Fmetrics%2Fcatalog", "%2Fetc%2Fpasswd"]) {
      const r = await localApp.handle(new Request(`http://x/nlq-eval/datasets/${bad}`));
      expect(r.status).toBe(404);
    }
  });
});

describe("SSE /nlq-eval/events/<job_id>", () => {
  it("replays a finished run's events and closes", async () => {
    await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    await queue.waitIdle();

    const r = await get("/nlq-eval/events/job1");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("ndjson");
    const text = await r.text();
    const lines = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);
    expect(types).toContain("start");
    expect(types).toContain("row");
    expect(types.at(-1)).toBe("done");
  });

  it("tells the client not to reuse its connection", async () => {
    db.patchJobState("jconn", { status: "paused", total: 1, completed: 0 });
    const r = await get("/nlq-eval/events/jconn");
    expect(r.headers.get("Connection")).toBe("close");
    await r.text();
  });

  it("404 for an unknown job", async () => {
    const r = await get("/nlq-eval/events/nope");
    expect(r.status).toBe(404);
  });

  it("skips a leftover 'paused' done-line on a run that is active again (S2-1)", async () => {
    // A run that was paused and then resumed is active, but the pause's durable
    // done{status:paused} may still sit in the log if it wasn't dropped. The
    // stream must NOT forward it (that would close the page and hide the
    // controls); it stays open and live-tails instead.
    db.patchJobState("jsse", { status: "started", total: 3, completed: 1 });
    db.createRun({
      job_id: "jsse",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.updateRunStatus("jsse", "started");
    sse.appendEvent("jsse", { type: "row", test_case_id: "a" });
    sse.appendEvent("jsse", { type: "done", status: "paused" }); // leftover

    const ctrl = new AbortController();
    const r = await app.handle(
      new Request("http://x/nlq-eval/events/jsse", { signal: ctrl.signal }),
    );
    expect(r.status).toBe(200);
    // Read the initial snapshot, then abort (the run is active → live tail).
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), 400));
    // Pull chunks until we've seen the replayed row (snapshot) or time out.
    while (!buf.includes('"row"')) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === null) break; // timed out — stream stayed open (good)
      if (chunk.done) break;
      if (chunk.value) buf += decoder.decode(chunk.value, { stream: true });
    }
    ctrl.abort();
    await reader.cancel().catch(() => {});
    const lines = buf
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // The row is replayed; the leftover paused done is NOT forwarded.
    expect(lines.some((l) => l.type === "row")).toBe(true);
    expect(lines.some((l) => l.type === "done")).toBe(false);
  });

  // Read an active run's stream until `until` matches the
  // buffer, the stream closes, or a timeout passes.
  async function readActive(jobId: string, until: (buf: string) => boolean, ms = 600) {
    const ctrl = new AbortController();
    const r = await app.handle(
      new Request(`http://x/nlq-eval/events/${jobId}`, { signal: ctrl.signal }),
    );
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let closed = false;
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), ms));
    while (!until(buf)) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === null) break;
      if (chunk.done) {
        closed = true;
        break;
      }
      if (chunk.value) buf += decoder.decode(chunk.value, { stream: true });
    }
    ctrl.abort();
    await reader.cancel().catch(() => {});
    const lines = buf
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { lines, closed };
  }

  function seedRun(jobId: string, status: string) {
    db.createRun({
      job_id: jobId,
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.updateRunStatus(jobId, status);
  }

  it("replay names the cases in flight, after the rows", async () => {
    db.patchJobState("jrun", { status: "started", total: 3, completed: 1, running_case_ids: ["b"] });
    seedRun("jrun", "started");
    sse.appendEvent("jrun", { type: "skeletons", items: [{ id: "a" }, { id: "b" }] });
    sse.appendEvent("jrun", { type: "row", testCaseId: "a" });
    const { lines } = await readActive("jrun", (b) => b.includes('"running"'));
    const iRow = lines.findIndex((l) => l.type === "row");
    const iRunning = lines.findIndex((l) => l.type === "running");
    expect(lines[iRunning]).toEqual({ type: "running", ids: ["b"] });
    expect(iRow).toBeGreaterThanOrEqual(0);
    expect(iRow).toBeLessThan(iRunning);
  });

  it("a settled run replays no cases in flight", async () => {
    db.patchJobState("jset", { status: "paused", total: 3, completed: 1, running_case_ids: ["b"] });
    seedRun("jset", "paused");
    sse.appendEvent("jset", { type: "skeletons", items: [{ id: "a" }] });
    const text = await (await get("/nlq-eval/events/jset")).text();
    expect(text).not.toContain('"running"');
  });

  it("a done from before the latest start does not close the stream", async () => {
    // A run closed by one pass and then started again is active: the old line
    // must not end a fresh connection before the live events.
    db.patchJobState("jre", { status: "started", total: 3, completed: 2 });
    seedRun("jre", "started");
    sse.appendEvent("jre", { type: "start", total: 3 });
    sse.appendEvent("jre", { type: "skeletons", items: [{ id: "a" }] });
    sse.appendEvent("jre", { type: "row", testCaseId: "a" });
    sse.appendEvent("jre", { type: "done", status: "finished" }); // the earlier pass
    sse.appendEvent("jre", { type: "start", total: 3 }); // the run goes on
    setTimeout(() => {
      sse.appendEvent("jre", { type: "row", testCaseId: "c" });
      sse.appendEvent("jre", { type: "done", status: "finished" });
    }, 100);
    const { lines, closed } = await readActive("jre", () => false, 1500);
    expect(closed).toBe(true);
    expect(lines).toContainEqual({ type: "row", testCaseId: "c" });
    expect(lines.filter((l) => l.type === "done")).toEqual([{ type: "done", status: "finished" }]);
  });

  it("a genuinely paused run still closes the stream with a paused done", async () => {
    db.patchJobState("jpz", { status: "paused", total: 2, completed: 1 });
    db.createRun({
      job_id: "jpz",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: {},
    });
    db.updateRunStatus("jpz", "paused");
    const r = await get("/nlq-eval/events/jpz");
    expect(r.status).toBe(200);
    const text = await r.text();
    const lines = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)!.type).toBe("done");
    expect(lines.at(-1)!.status).toBe("paused");
  });
});

describe("preflight", () => {
  it("delegates to runPreflight and records verification (offline fetch)", async () => {
    // tableauFetch returns 200 {} for serverinfo; preflight will fail later
    // stages but should still return 200 with a result shape.
    const r = await send("POST", "/nlq-eval/preflight", {
      tableau_server: "https://tab.example.com",
    });
    expect(r.status).toBe(200);
    const body = await jsonOf<Record<string, unknown>>(r);
    expect(body).toHaveProperty("server");
    expect(body).toHaveProperty("ok");
  });

  it("derives ces_url from THIS request's server (first-time, nothing stored)", async () => {
    // Capture the generations probe URL to prove the derived ces_url is used.
    const urls: string[] = [];
    const fetchSpy = (async (input: Parameters<typeof fetch>[0]) => {
      const u = typeof input === "string" ? input : input.toString();
      urls.push(u);
      if (u.includes("serverinfo")) return new Response(JSON.stringify({ serverInfo: {} }), { status: 200 });
      if (u.includes("auth/signin"))
        return new Response(JSON.stringify({ credentials: { token: "t", site: { id: "s1" } } }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: fetchSpy,
      genJobId: () => `jobpf${++jobIdCounter}`,
    });
    app.init();
    await send("POST", "/nlq-eval/preflight", {
      tableau_server: "https://fresh.example/",
      tableau_pat_name: "p",
      tableau_pat_value: "v",
    });
    expect(urls.some((u) => u.startsWith("https://fresh.example/content-exploration"))).toBe(true);
  });

  it("does not reuse a stored ces_url when testing a different server", async () => {
    await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://old.example",
      site: "",
      pat_name: "p",
      pat_value: "v",
      verify_tls: true,
      ces_url: "http://old-ces:8080",
    });
    const urls: string[] = [];
    const fetchSpy = (async (input: Parameters<typeof fetch>[0]) => {
      const u = typeof input === "string" ? input : input.toString();
      urls.push(u);
      if (u.includes("serverinfo")) return new Response(JSON.stringify({ serverInfo: {} }), { status: 200 });
      if (u.includes("auth/signin"))
        return new Response(JSON.stringify({ credentials: { token: "t", site: { id: "s1" } } }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: fetchSpy,
      genJobId: () => `jobpf2${++jobIdCounter}`,
    });
    app.init();
    // Different server -> derive its own CES, NOT the stored old-ces.
    await send("POST", "/nlq-eval/preflight", { tableau_server: "https://new.example" });
    expect(urls.some((u) => u.startsWith("https://new.example/content-exploration"))).toBe(true);
    expect(urls.some((u) => u.includes("old-ces"))).toBe(false);
  });
});

describe("GET /nlq-eval/version", () => {
  it("returns version + frozen + data_dir", async () => {
    const r = await get("/nlq-eval/version");
    expect(r.status).toBe(200);
    const body = await jsonOf<{ version: string; frozen: boolean }>(r);
    expect(typeof body.version).toBe("string");
    expect(typeof body.frozen).toBe("boolean");
    expect(body).toHaveProperty("commit");
    expect(body).toHaveProperty("data_dir");
    expect(body).toHaveProperty("ca_bundle");
  });
});

describe("preflight token-clash guard", () => {
  it("409s when a running job uses the same PAT name", async () => {
    db.patchJobState("jclash", { status: "started", pat_name: "shared-tok" });
    db.createRun({
      job_id: "jclash",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: { tableau_pat_name: "shared-tok" },
    });
    db.updateRunStatus("jclash", "started");

    const r = await send("POST", "/nlq-eval/preflight", {
      tableau_server: "https://tab.example.com",
      tableau_pat_name: "shared-tok",
      tableau_pat_value: "v",
    });
    expect(r.status).toBe(409);
    const body = await jsonOf<ErrorResponse>(r);
    expect(body.job_id).toBe("jclash");
    expect(String(body.error)).toContain("one live session");
  });

  it("does not 409 for a different PAT name", async () => {
    db.patchJobState("jclash2", { status: "started", pat_name: "tok-A" });
    db.createRun({
      job_id: "jclash2",
      org_id: "",
      user_id: "",
      ai_feature: "",
      runner_name: "",
      config: { tableau_pat_name: "tok-A" },
    });
    db.updateRunStatus("jclash2", "started");

    const r = await send("POST", "/nlq-eval/preflight", {
      tableau_server: "https://tab.example.com",
      tableau_pat_name: "tok-B",
      tableau_pat_value: "v",
    });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Route-parity coverage — these lock in the CURRENT dispatcher behavior for
// routes/method-combos not otherwise exercised, so a routing refactor (e.g.
// migrating to declarative Bun.serve routes) can be verified byte-for-byte.
// ---------------------------------------------------------------------------

describe("GET settings variants (method-switch parity)", () => {
  it("GET /nlq-eval/settings/content returns the content settings shape", async () => {
    const r = await get("/nlq-eval/settings/content");
    expect(r.status).toBe(200);
    const body = await jsonOf<ContentResponse>(r);
    expect(body).toHaveProperty("pinned_runs");
    expect(body).toHaveProperty("public_suites_found");
    expect(Array.isArray(body.pinned_runs)).toBe(true);
  });

  it("GET /nlq-eval/settings/judge reports configured=false when unset", async () => {
    const r = await get("/nlq-eval/settings/judge");
    expect(r.status).toBe(200);
    expect((await jsonOf<JudgeResponse>(r)).configured).toBe(false);
  });

  it("GET /nlq-eval/settings/judge masks api_key and reports configured=true after a PUT", async () => {
    const put = await send("PUT", "/nlq-eval/settings/judge", {
      provider: "openai",
      model: "gpt-4.1",
      api_key: "supersecretvalue",
    });
    expect(put.status).toBe(200);
    const r = await get("/nlq-eval/settings/judge");
    expect(r.status).toBe(200);
    const body = await jsonOf<JudgeResponse>(r);
    expect(body.configured).toBe(true);
    expect(body.provider).toBe("openai");
    // api_key must never be returned in the clear.
    expect(String(body.api_key)).toContain("****");
    expect(String(body.api_key)).not.toBe("supersecretvalue");
  });

  it("GET /nlq-eval/settings/tableau reports configured=false when unset", async () => {
    const r = await get("/nlq-eval/settings/tableau");
    expect(r.status).toBe(200);
    expect((await jsonOf<TableauResponse>(r)).configured).toBe(false);
  });
});

describe("GET /results-classic/<job_id>", () => {
  it("renders an HTML page for a known job", async () => {
    await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    await queue.waitIdle();
    const r = await get("/results-classic/job1");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Tableau AI Model Evaluation Tool results");
    expect(html).toContain("/nlq-eval/results/job1");
  });

  it("returns a 404 HTML page for an unknown job", async () => {
    const r = await get("/results-classic/nope");
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    expect(await r.text()).toContain("Job not found");
  });
});

describe("POST /nlq-eval/publish/<job_id> (route wiring)", () => {
  it("returns 404 for an unknown job before any Tableau call", async () => {
    const r = await send("POST", "/nlq-eval/publish/nope", {
      tableau_server: "https://tab.example.com",
      pat_name: "n",
      pat_value: "v",
      site: "s",
    });
    expect(r.status).toBe(404);
    expect((await jsonOf<ErrorResponse>(r)).reason).toBe("unknown_job");
  });
});

// ---------------------------------------------------------------------------
// postPublish credential merge / validation + REST error-mapping + success.
// These build a dedicated app whose injected tableauFetch scripts the Tableau
// REST flow, so nothing hits a live server. NOTE: publishRun runs buildHyper
// FIRST (hyper.ts:624), which needs a real hyperd; hyperd IS available in this
// environment (hyper.test.ts passes), so both the true-success path and the
// post-buildHyper REST error-mapping branches are reachable offline.
// ---------------------------------------------------------------------------
describe("POST /nlq-eval/publish/<job_id> (credentials + REST mapping)", () => {
  // A scripted Tableau REST fetch: matches by (method, url-substring).
  function scriptedFetch(
    handlers: Array<{
      match: (url: string, method: string) => boolean;
      resp: () => Response;
    }>,
  ): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method as string) ?? "GET";
      for (const h of handlers) {
        if (h.match(u, method)) return h.resp();
      }
      throw new Error(`unhandled fetch: ${method} ${u}`);
    }) as unknown as typeof fetch;
  }

  function jsonResp(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signin = () =>
    jsonResp({ credentials: { token: "TOK-1", site: { id: "SITE-1" } } });

  // Build a fresh app with a custom tableauFetch + a finished run seeded via
  // POST /run (so getFullResults is non-null). Returns the app + helpers.
  async function appWithFinishedRun(
    tableauFetch: typeof fetch,
  ): Promise<{
    localDb: AiEvalDb;
    localApp: NlqEvalApp;
    jobId: string;
    sendTo: (method: string, path: string, body?: unknown) => Promise<Response>;
    close: () => void;
  }> {
    const localDb = new AiEvalDb(":memory:");
    localDb.initDb();
    const localSse = new SseState(localDb);
    const localQueue = new JobQueue({ acquireInhibitor: () => ({ release() {} }) });
    let counter = 0;
    const localApp = createNlqEvalApp({
      db: localDb,
      sse: localSse,
      queue: localQueue,
      suiteBases: { publicBase: null },
      tableauFetch,
      genJobId: () => `job${++counter}`,
      orchestratorOverrides: { getAdapter: async () => fakeAdapter(["a", "b"]) },
    });
    localApp.init();
    const sendTo = (method: string, path: string, body?: unknown) =>
      localApp.handle(
        new Request(`http://x${path}`, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          headers:
            body === undefined
              ? undefined
              : { "Content-Type": "application/json" },
        }),
      );
    await sendTo("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    await localQueue.waitIdle();
    return { localDb, localApp, jobId: "job1", sendTo, close: () => localDb.close() };
  }

  it("400 with the missing fields when no stored settings and no creds in body", async () => {
    // Default buildApp() has no stored tableau settings; publish a *known*
    // finished run so the missing-creds guard (not the 404 guard) fires.
    await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    await queue.waitIdle();
    const r = await send("POST", "/nlq-eval/publish/job1", {});
    expect(r.status).toBe(400);
    const err = String((await jsonOf<ErrorResponse>(r)).error);
    expect(err).toContain("Connect to Tableau Server first");
  });

  it("merges stored tableau settings so the request passes validation", async () => {
    // Seed stored settings; POST with an empty body should merge server/pat*
    // from settings, pass validation, and reach the REST flow (mapped below).
    // We assert it does NOT 400 (validation passed) — a 401 signin proves the
    // creds were merged and used.
    const fetchImpl = scriptedFetch([
      { match: (u) => u.includes("/auth/signin"), resp: () => new Response("nope", { status: 401 }) },
    ]);
    const { localDb, sendTo, jobId, close } = await appWithFinishedRun(fetchImpl);
    try {
      localDb.setSetting("tableau", {
        server_url: "https://tab.example.com",
        site: "s",
        pat_name: "storedPat",
        pat_value: "storedSecret",
        verify_tls: true,
      });
      const r = await sendTo("POST", `/nlq-eval/publish/${jobId}`, {});
      // Merge succeeded (else 400); signin refused → TableauAuthError → 401.
      expect(r.status).toBe(401);
    } finally {
      close();
    }
  });

  it("maps a TableauAuthError (401 signin) to HTTP 401", async () => {
    const fetchImpl = scriptedFetch([
      { match: (u) => u.includes("/auth/signin"), resp: () => new Response("bad pat", { status: 401 }) },
    ]);
    const { sendTo, jobId, close } = await appWithFinishedRun(fetchImpl);
    try {
      const r = await sendTo("POST", `/nlq-eval/publish/${jobId}`, {
        tableau_server: "https://tab.example.com",
        pat_name: "n",
        pat_value: "v",
        tableau_site: "s",
      });
      expect(r.status).toBe(401);
    } finally {
      close();
    }
  });

  it("returns Hyper setup errors in the publish response consumed by the error toast", async () => {
    const { sendTo, jobId, close } = await appWithFinishedRun(scriptedFetch([]));
    const previous = process.env.HYPERD_PATH;
    process.env.HYPERD_PATH = `/nonexistent-tableau-ai-eval-hyper-${process.pid}/hyperd`;
    try {
      const response = await sendTo("POST", `/nlq-eval/publish/${jobId}`, {
        tableau_server: "https://tab.example.com", pat_name: "n", pat_value: "v",
      });
      expect(response.status).toBe(502);
      expect(String((await jsonOf<ErrorResponse>(response)).error)).toContain("HYPERD_PATH does not exist");
    } finally {
      if (previous === undefined) delete process.env.HYPERD_PATH;
      else process.env.HYPERD_PATH = previous;
      close();
    }
  });

  it("maps a REST HttpError (500 on a REST call after signin) to HTTP 502", async () => {
    const fetchImpl = scriptedFetch([
      { match: (u) => u.includes("/auth/signin"), resp: signin },
      // The first REST call after signin is the projects lookup; 500 it.
      {
        match: (u, m) => u.includes("/projects") && m === "GET",
        resp: () => new Response("boom", { status: 500 }),
      },
    ]);
    const { sendTo, jobId, close } = await appWithFinishedRun(fetchImpl);
    try {
      const r = await sendTo("POST", `/nlq-eval/publish/${jobId}`, {
        tableau_server: "https://tab.example.com",
        pat_name: "n",
        pat_value: "v",
        tableau_site: "s",
      });
      expect(r.status).toBe(502);
      expect(String((await jsonOf<ErrorResponse>(r)).error)).toContain("Tableau Server returned an error while publishing");
    } finally {
      close();
    }
  });

  it("publishes successfully (create path) with a fully-scripted REST flow", async () => {
    const fetchImpl = scriptedFetch([
      { match: (u) => u.includes("/auth/signin"), resp: signin },
      // project exists
      {
        match: (u, m) => u.includes("/projects") && m === "GET",
        resp: () => jsonResp({ projects: { project: [{ id: "PROJ-1" }] } }),
      },
      // datasource does not exist → publishNew (single-request create)
      {
        match: (u, m) => u.includes("/datasources") && m === "GET",
        resp: () => jsonResp({ datasources: { datasource: [] } }),
      },
      {
        match: (u, m) => u.includes("/datasources") && m === "POST",
        resp: () => jsonResp({ datasource: { id: "DS-NEW" } }),
      },
      // tag the new datasource with the schema version
      {
        match: (u, m) => u.endsWith("/datasources/DS-NEW/tags") && m === "PUT",
        resp: () => jsonResp({ tags: {} }),
      },
    ]);
    const { sendTo, jobId, close } = await appWithFinishedRun(fetchImpl);
    try {
      const r = await sendTo("POST", `/nlq-eval/publish/${jobId}`, {
        tableau_server: "https://tab.example.com",
        pat_name: "n",
        pat_value: "v",
        tableau_site: "s",
      });
      expect(r.status).toBe(200);
      const body = await jsonOf<PublishResponse>(r);
      expect(body.action).toBe("created");
      expect(body.datasource_id).toBe("DS-NEW");
      expect(body.run_id).toBe(jobId);
      expect(body.schema_version).toBe(3);
    } finally {
      close();
    }
  });

  it("409 schema_mismatch for a same-name datasource from an earlier schema", async () => {
    const fetchImpl = scriptedFetch([
      { match: (u) => u.includes("/auth/signin"), resp: signin },
      {
        match: (u, m) => u.includes("/projects") && m === "GET",
        resp: () => jsonResp({ projects: { project: [{ id: "PROJ-1" }] } }),
      },
      {
        // listed WITHOUT the ai-model-eval-schema-3 tag
        match: (u, m) => u.includes("/datasources") && m === "GET",
        resp: () =>
          jsonResp({ datasources: { datasource: [{ id: "DS-OLD", project: { id: "PROJ-1" } }] } }),
      },
    ]);
    const { sendTo, jobId, close } = await appWithFinishedRun(fetchImpl);
    try {
      const r = await sendTo("POST", `/nlq-eval/publish/${jobId}`, {
        tableau_server: "https://tab.example.com",
        pat_name: "n",
        pat_value: "v",
      });
      expect(r.status).toBe(409);
      const body = await jsonOf<ErrorResponse>(r);
      expect(body.reason).toBe("schema_mismatch");
      expect(String(body.error)).toContain("earlier version");
    } finally {
      close();
    }
  });
});

describe("run identity snapshot + export naming", () => {
  it("org_id is no longer required to launch a run", async () => {
    const r = await send("POST", "/nlq-eval/run", {
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
    });
    expect(r.status).toBe(202);
    await queue.waitIdle();
  });

  it("export file name says suite, model, date and run", async () => {
    await send("POST", "/nlq-eval/run", {
      org_id: "o",
      llm_key: "k",
      gateway_url: "https://gw.example.com",
      adapter: "fake",
      suite_id: "calcs-public",
      models: { create: "gpt-4o-mini" },
    });
    await queue.waitIdle();
    const r = await get("/nlq-eval/export/job1?format=csv");
    expect(r.status).toBe(200);
    const cd = r.headers.get("Content-Disposition") ?? "";
    expect(cd).toMatch(
      /^attachment; filename="ai-model-eval_calcs-public_gpt-4o-mini_\d{4}-\d{2}-\d{2}_job1\.csv"$/,
    );
    const header = (await r.text()).split("\r\n")[0].split(",");
    expect(header.slice(0, 3)).toEqual(["schema_version", "run_id", "tool_version"]);
  });

  it("a customer-path launch records server, site, version and the site's model", async () => {
    // Scripted Tableau: serverinfo, PAT sign-in, Site Settings models.
    const tableauFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/serverinfo"))
        return Response.json({
          serverInfo: { productVersion: { value: "2026.3.0", build: "20263.26.0930.1736" } },
        });
      if (u.includes("/auth/signin"))
        return Response.json({ credentials: { token: "TOK", site: { id: "SITE-LUID" } } });
      if (u.includes("/sites/SITE-LUID"))
        return Response.json({
          site: {
            siteSettings: [
              { key: "generativeAiVizAndCalcGenerationModel", value: "claude-sonnet-4-6" },
              { key: "onPremLLMProvider", value: "anthropic" },
            ],
          },
        });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const localDb = new AiEvalDb(":memory:");
    localDb.initDb();
    const localQueue = new JobQueue({ acquireInhibitor: () => ({ release() {} }) });
    const localApp = createNlqEvalApp({
      db: localDb,
      sse: new SseState(localDb),
      queue: localQueue,
      suiteBases: { publicBase: null },
      tableauFetch,
      genJobId: () => "jobC",
      orchestratorOverrides: { getAdapter: async () => fakeAdapter(["a"]) },
    });
    localApp.init();
    try {
      const r = await localApp.handle(
        new Request("http://x/nlq-eval/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            adapter: "fake",
            generations_mode: "ces",
            ces_url: "https://tab.example.com/content-exploration",
            tableau_server: "https://tab.example.com/",
            tableau_site: "Sales",
            tableau_pat_name: "n",
            tableau_pat_value: "v",
          }),
        }),
      );
      expect(r.status).toBe(202);
      await localQueue.waitIdle();
      const cfg = localDb.getRun("jobC")!.config as Record<string, unknown>;
      expect(cfg.tableau_server_url).toBe("https://tab.example.com");
      expect(cfg.tableau_site_name).toBe("Sales");
      expect(cfg.tableau_server_version).toBe("2026.3.0 (20263.26.0930.1736)");
      expect(cfg.tableau_site_luid).toBe("SITE-LUID");
      expect(cfg.tool_version).toBeTruthy();
      expect(cfg.resolved_site_model).toBe("claude-sonnet-4-6");
      expect(cfg.site_model_provider).toBe("anthropic");
      // The embedded bridge's loopback address never reaches the run record.
      expect(String(cfg.gateway_url ?? "")).not.toContain("127.0.0.1");
    } finally {
      localDb.close();
    }
  });
});

describe("dispatcher not-found semantics", () => {
  it("returns JSON 404 {error:'not found'} for an unmatched /nlq-eval path", async () => {
    const r = await get("/nlq-eval/does-not-exist");
    expect(r.status).toBe(404);
    expect((await jsonOf<ErrorResponse>(r)).error).toBe("not found");
  });

  it("returns JSON 404 for a matched path with the wrong method", async () => {
    // /nlq-eval/suites is GET-only; a POST falls through to the 404 tail.
    const r = await send("POST", "/nlq-eval/suites");
    expect(r.status).toBe(404);
    expect((await jsonOf<ErrorResponse>(r)).error).toBe("not found");
  });
});

// ---------------------------------------------------------------------------
// Tableau Agent in Authoring off on the site. The connection test records the
// verdict; the suite catalog disables the suites the server gates on that
// switch (Build a visualization, Calculated fields, Color palettes) with the
// reason, and the run request refuses them with the same reason. The other
// suites, and the connection, are unaffected.
// ---------------------------------------------------------------------------

describe("Tableau Agent in Authoring off on the site", () => {
  let authoring: "on" | "off" = "off";

  function scriptedFetch(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("serverinfo"))
        return Response.json({ serverInfo: { productVersion: { value: "2026.3.0", build: "20263.26.0930.1736" } } });
      if (u.includes("auth/signin"))
        return Response.json({ credentials: { token: "t", site: { id: "site-1" } } });
      if (u.includes("/sites/")) return Response.json({ site: { siteSettings: [] } });
      if (u.includes("/color-palettes/generate"))
        return authoring === "off"
          ? Response.json({ errorMsg: "403 The Tableau Agent Viz Authoring site setting is not enabled for this site." }, { status: 403 })
          : Response.json({ errorMsg: "400 Missing utterance content." }, { status: 400 });
      if (u.includes("/cabu/conversations")) return Response.json({ errorMsg: "workbook not found" }, { status: 400 });
      if (u.includes("generations")) return Response.json({ generations: [{ text: "pong" }] });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    authoring = "off";
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: scriptedFetch(),
      genJobId: () => `jobauth${++jobIdCounter}`,
      orchestratorOverrides: { getAdapter: async () => fakeAdapter(["a"]) },
    });
    app.init();
  });

  async function connect(): Promise<void> {
    let r = await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://tab.example.com",
      site: "dev",
      pat_name: "eval-pat",
      pat_value: "secret",
    });
    expect(r.status).toBe(200);
    r = await send("POST", "/nlq-eval/preflight", {});
    expect(r.status).toBe(200);
  }

  const GATED = new Set(["agent", "palettes"]);

  it("the connection test records the switch without failing the connection", async () => {
    await connect();
    const verified = (await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"))).last_verified;
    expect(verified?.ok).toBe(true);
    expect(verified?.web_authoring).toEqual({
      enabled: false,
      message: expect.stringContaining("Tableau Agent in Authoring is turned off"),
    });
  });

  it("only the suites the switch gates are disabled, with the reason", async () => {
    await connect();
    const body = await jsonOf<SuitesResponse & { web_authoring_off: { message: string } | null }>(await get("/nlq-eval/suites"));
    expect(body.web_authoring_off?.message).toContain("Site Settings");
    const gated = body.suites.filter((s) => GATED.has(String(s.adapter)));
    const others = body.suites.filter((s) => !GATED.has(String(s.adapter)));
    expect(gated.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    for (const suite of gated) {
      expect(suite.server_supported).toBe(false);
      expect(suite.server_message).toContain("Tableau Agent in Authoring is turned off");
    }
    expect(others.every((s) => s.server_supported)).toBe(true);
  });

  it("a run of a gated suite is refused with the same reason, and allowed once the switch is on", async () => {
    await connect();
    const r = await send("POST", "/nlq-eval/run", { adapter: "palettes", suite_id: "color-palette" });
    expect(r.status).toBe(400);
    const body = await jsonOf<ErrorResponse>(r);
    expect(body.reason).toBe("web_authoring_disabled");
    expect(body.error).toContain("Tableau Agent in Authoring is turned off");
    expect(db.listRuns(10)).toHaveLength(0);

    authoring = "on";
    await connect();
    const suites = await jsonOf<SuitesResponse & { web_authoring_off: unknown }>(await get("/nlq-eval/suites"));
    expect(suites.web_authoring_off).toBeNull();
    expect(suites.suites.every((s) => s.server_supported)).toBe(true);
    const ok = await send("POST", "/nlq-eval/run", { adapter: "palettes", suite_id: "color-palette" });
    expect(ok.status).toBe(202);
    await queue.waitIdle();
  });
});

// ---------------------------------------------------------------------------
// A Tableau Server earlier than 2026.3. The connection test records the verdict;
// the suite catalog then
// disables every server-routed suite with the reason, and the run and resume
// requests refuse with the same reason. The connection itself is kept.
// ---------------------------------------------------------------------------

describe("server release earlier than 2026.3", () => {
  let version = "2025.3.2";
  let build = "20253.26.0115.0900";
  let generations = 404;

  function scriptedFetch(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("serverinfo"))
        return Response.json({ serverInfo: { productVersion: { value: version, build } } });
      if (u.includes("auth/signin"))
        return Response.json({ credentials: { token: "t", site: { id: "site-1" } } });
      if (u.includes("/sites/")) return Response.json({ site: { siteSettings: [] } });
      if (u.includes("generations")) {
        return generations === 200
          ? Response.json({ generations: [{ text: "pong" }] })
          : new Response("Not Found", { status: generations });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    version = "2025.3.2";
    build = "20253.26.0115.0900";
    generations = 404;
    app = createNlqEvalApp({
      db,
      sse,
      queue,
      suiteBases: { publicBase: null },
      tableauFetch: scriptedFetch(),
      genJobId: () => `jobold${++jobIdCounter}`,
      orchestratorOverrides: { getAdapter: async () => fakeAdapter(["a"]) },
    });
    app.init();
  });

  async function connect(tooOld: boolean): Promise<void> {
    if (tooOld) {
      version = "2025.3.2";
      build = "20253.26.0115.0900";
      generations = 404;
    } else {
      version = "2026.3.0";
      build = "20263.26.0930.1736";
      generations = 200;
    }
    let r = await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://tab.example.com",
      site: "dev",
      pat_name: "eval-pat",
      pat_value: "secret",
    });
    expect(r.status).toBe(200);
    r = await send("POST", "/nlq-eval/preflight", {});
    expect(r.status).toBe(200);
  }

  const RUN = { runner: "calc-prompt", generations_mode: "ces", suite_id: "calcs-public" };

  it("settings report the verdict with the connection", async () => {
    await connect(true);
    const verified = (await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"))).last_verified;
    if (!verified?.server_too_old) throw new Error("Expected an earlier-server verdict");
    expect(verified.ok).toBe(false);
    expect(verified.connection_ok).toBe(true);
    expect(verified.server_version).toBe("2025.3.2 (20253.26.0115.0900)");
    expect(verified.server_too_old.release).toBe("2025.3");
    expect(verified.server_too_old.message).toContain("earlier than 2026.3");
    expect(verified.failed_stage).toBe("generations");
  });

  it("suites are disabled with the reason", async () => {
    await connect(true);
    const body = await jsonOf<SuitesResponse>(await get("/nlq-eval/suites"));
    expect(body.server_too_old?.release).toBe("2025.3");
    expect(body.suites.length).toBeGreaterThan(0);
    for (const suite of body.suites) {
      expect(suite.server_routed).toBe(true);
      expect(suite.server_supported).toBe(false);
      expect(suite.server_message).toContain("earlier than 2026.3");
    }
  });

  it("suites are enabled again after a passing test", async () => {
    await connect(true);
    await connect(false);
    const body = await jsonOf<SuitesResponse>(await get("/nlq-eval/suites"));
    expect(body.server_too_old).toBeNull();
    expect(body.suites.every((s: { server_supported: boolean }) => s.server_supported)).toBe(true);
    const verified = (await jsonOf<TableauResponse>(await get("/nlq-eval/settings/tableau"))).last_verified;
    expect(verified?.server_too_old).toBeNull();
  });

  it("suites are not disabled without a connection", async () => {
    const body = await jsonOf<SuitesResponse>(await get("/nlq-eval/suites"));
    expect(body.server_too_old).toBeNull();
    expect(body.suites.every((s: { server_supported: boolean }) => s.server_supported)).toBe(true);
  });

  it("a run is refused with the same reason the suites carry", async () => {
    await connect(true);
    const suiteMsg = (await jsonOf<SuitesResponse>(await get("/nlq-eval/suites"))).suites[0].server_message;
    if (suiteMsg === null) throw new Error("Expected a suite refusal message");
    const r = await send("POST", "/nlq-eval/run", RUN);
    expect(r.status).toBe(400);
    const body = await jsonOf<ErrorResponse>(r);
    expect(body.reason).toBe("server_too_old");
    expect(body.error).toContain("Tableau Server 2025.3 is earlier than 2026.3");
    expect(body.error).toBe(suiteMsg);
    expect(db.listRuns(10)).toHaveLength(0);
  });

  it("a run against another server is not refused", async () => {
    // The verdict belongs to the tested connection; an API caller naming a
    // different server is not judged by it.
    await connect(true);
    const r = await send("POST", "/nlq-eval/run", {
      ...RUN,
      tableau_server: "https://other.example.com",
      tableau_pat_name: "p",
      tableau_pat_value: "s",
    });
    expect(r.status).toBe(202);
    await queue.waitIdle();
  });

  it("a resume is refused too", async () => {
    await connect(false);
    const r = await send("POST", "/nlq-eval/run", RUN);
    expect(r.status).toBe(202);
    const { job_id } = await jsonOf<LaunchResponse>(r);
    await queue.waitIdle();
    db.updateRunStatus(job_id, "paused");
    db.patchJobState(job_id, { status: "paused" });
    // The server was downgraded (or re-pointed) and tested again since.
    await connect(true);
    const res = await send("POST", `/nlq-eval/resume/${job_id}`, {});
    expect(res.status).toBe(409);
    expect((await jsonOf<ErrorResponse>(res)).reason).toBe("server_too_old");
  });
});

// Settings are frozen while an evaluation is queued or running, and the
// evaluated model's family comes from the connection test (bug bash
// 2026-10-23, items 5, 6 and 22).
describe("settings while an evaluation is active", () => {
  const seedRun = (status: string) => {
    db.createRun({ job_id: "live1", org_id: "", user_id: "", ai_feature: "", runner_name: "", config: {} });
    db.updateRunStatus("live1", status);
    db.patchJobState("live1", { status });
  };

  it("PUT settings/judge is refused while a run is queued", async () => {
    seedRun("queued");
    const r = await send("PUT", "/nlq-eval/settings/judge", { provider: "openai", model: "gpt-4o", api_key: "sk-1" });
    expect(r.status).toBe(409);
    const body = await jsonOf<ErrorResponse & { job_id?: string }>(r);
    expect(body.reason).toBe("run_in_progress");
    expect(body.job_id).toBe("live1");
    expect((await jsonOf<JudgeResponse>(await get("/nlq-eval/settings/judge"))).configured).toBe(false);
  });

  it("PUT settings/tableau is refused while a run is started", async () => {
    seedRun("started");
    const r = await send("PUT", "/nlq-eval/settings/tableau", {
      server_url: "https://tab.example", site: "s", pat_name: "n", pat_value: "v",
    });
    expect(r.status).toBe(409);
    expect((await jsonOf<ErrorResponse>(r)).reason).toBe("run_in_progress");
  });

  it("a finished run does not freeze the settings", async () => {
    seedRun("finished");
    const r = await send("PUT", "/nlq-eval/settings/judge", { provider: "openai", model: "gpt-4o", api_key: "sk-1" });
    expect(r.status).toBe(200);
  });

  it("resume is refused when the evaluator model changed since the run started", async () => {
    db.setSetting("judge", { provider: "openai", model: "gpt-4o", api_key: "k" });
    // A direct-gateway run with its secrets in the body, so resume gets as
    // far as the evaluator check.
    db.createRun({ job_id: "p1", org_id: "", user_id: "", ai_feature: "", runner_name: "fake",
      config: { compute_nl_judge: true, adapter: "fake", llm_key: "k", gateway_url: "https://gw.example" } });
    db.updateRunStatus("p1", "paused");
    db.patchJobState("p1", { status: "paused", judge_provider: "openai", judge_model: "gpt-4o" });
    db.setSetting("judge", { provider: "anthropic", model: "claude-sonnet-4-5", api_key: "k" });
    // Secrets are redacted at rest, so the resume body carries them.
    const r = await send("POST", "/nlq-eval/resume/p1", { llm_key: "k", gateway_url: "https://gw.example" });
    expect(r.status).toBe(409);
    const body = await jsonOf<ErrorResponse>(r);
    expect(body.reason).toBe("judge_changed");
    expect(body.error).toContain("openai gpt-4o");
    expect(body.error).toContain("anthropic claude-sonnet-4-5");
  });
});

describe("the evaluated model's family comes from the connection test", () => {
  const connect = (modelFamily: string | null) => {
    const conn = { server_url: "https://tab.example", site: "s", pat_name: "n", pat_value: "v" };
    db.setSetting("tableau", conn);
    db.setSetting("tableau_preflight", {
      ok: true,
      // The identity the context computes: server, site and token name.
      identity: [conn.server_url, conn.site, conn.pat_name],
      generations: { ok: true, model_family: modelFamily },
    });
  };

  it("GET settings/judge reports the family before and after an evaluator model is saved", async () => {
    connect("anthropic");
    let body = await jsonOf<JudgeResponse & { evaluated_model_family?: string | null }>(await get("/nlq-eval/settings/judge"));
    expect(body.configured).toBe(false);
    expect(body.evaluated_model_family).toBe("anthropic");
    const put = await send("PUT", "/nlq-eval/settings/judge", { provider: "anthropic", model: "claude-sonnet-4-5", api_key: "k" });
    expect(put.status).toBe(200);
    expect((await jsonOf<JudgeUpdateResponse>(put)).warnings.length).toBe(1);
    body = await jsonOf<JudgeResponse & { evaluated_model_family?: string | null }>(await get("/nlq-eval/settings/judge"));
    expect(body.evaluated_model_family).toBe("anthropic");
    expect(body.same_family_warning).toBe(true);
  });

  it("an evaluator model from another family carries no warning", async () => {
    connect("anthropic");
    const put = await send("PUT", "/nlq-eval/settings/judge", { provider: "openai", model: "gpt-4.1", api_key: "k" });
    expect((await jsonOf<JudgeUpdateResponse>(put)).warnings.length).toBe(0);
    const body = await jsonOf<JudgeResponse>(await get("/nlq-eval/settings/judge"));
    expect(body.same_family_warning).toBe(false);
  });

  it("without a connection test the family is unknown and no warning is raised", async () => {
    const put = await send("PUT", "/nlq-eval/settings/judge", { provider: "openai", model: "gpt-4.1", api_key: "k" });
    expect((await jsonOf<JudgeUpdateResponse>(put)).warnings.length).toBe(0);
    const body = await jsonOf<JudgeResponse & { evaluated_model_family?: string | null }>(await get("/nlq-eval/settings/judge"));
    expect(body.evaluated_model_family).toBeNull();
  });
});

describe("GET /nlq-eval/datasets/:id/rows", () => {
  it("is 404 for a dataset that ships as a field list only", async () => {
    const r = await get("/nlq-eval/datasets/no-such-dataset/rows");
    expect(r.status).toBe(404);
    expect((await jsonOf<ErrorResponse>(r)).error).toContain("fields only");
  });
});
