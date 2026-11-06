import { expect, test } from "bun:test";
import { AiEvalDb, SseState, sharedSession, TableauSession, type EvalAdapter, type FetchLike } from "@tableau-ai-eval/core";
import { JobQueue } from "../worker/queue.ts";
import { createNlqEvalApp } from "./nlq_eval.ts";

/** Tableau's live-verified rule: a second PAT signin invalidates the first. */
function singleSessionServer() {
  let signins = 0;
  let current = "";
  const fetchImpl = (async (url, init) => {
    if (String(url).endsWith("/auth/signin")) {
      current = `token-${++signins}`;
      return Response.json({ credentials: { token: current, site: { id: "site" } } });
    }
    if (String(url).includes("serverinfo")) return Response.json({ serverInfo: {} });
    const token = new Headers(init?.headers).get("X-Tableau-Auth");
    return token === current ? Response.json({ site: {} }) : Response.json({ error: "session ended" }, { status: 401 });
  }) as FetchLike;
  return { fetchImpl, signins: () => signins };
}

test("independent identity signin actually invalidates a running PAT session", async () => {
  const server = singleSessionServer();
  const options = { serverUrl: "https://tableau.example", patName: "p", patSecret: "secret", fetchImpl: server.fetchImpl };
  const running = new TableauSession(options);
  const token = await running.getToken();
  const check = () => server.fetchImpl("https://tableau.example/api/3.22/sites/site", { headers: { "X-Tableau-Auth": token } });
  expect((await check()).status).toBe(200);
  await new TableauSession(options).getToken();
  expect((await check()).status).toBe(401);
});

test("launching the next batch suite reuses the active session instead of invalidating it", async () => {
  const db = new AiEvalDb(":memory:");
  db.initDb();
  const server = singleSessionServer();
  const queue = new JobQueue({ acquireInhibitor: () => ({ release() {} }) });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let runningToken = "";
  const adapter: EvalAdapter = {
    id: "fake", session: () => ({ close() {} }),
    load: () => ({ total: 1, skeletons: [], conversation_ids: [["case"]] }),
    async execute(_plan, config) {
      if (config.suite_id !== "first") return;
      runningToken = await sharedSession(String(config.job_id))!.getToken();
      started();
      await barrier;
    },
  };
  let id = 0;
  const app = createNlqEvalApp({ db, sse: new SseState(db), queue,
    tableauFetch: server.fetchImpl, genJobId: () => `batch-${++id}`,
    orchestratorOverrides: { getAdapter: async () => adapter, cesFetch: server.fetchImpl },
  });
  app.init();
  const launch = (suite_id: string) => app.handle(new Request("http://x/nlq-eval/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suite_id, batch_id: "batch", tableau_server: "https://tableau.example", pat_name: "p", pat_value: "secret", ces_url: "https://tableau.example/content-exploration", generations_mode: "ces" }),
  }));
  try {
    expect((await launch("first")).status).toBe(202);
    await ready;
    const before = server.signins();
    expect((await launch("second")).status).toBe(202);
    expect(server.signins()).toBe(before);
    expect((await server.fetchImpl("https://tableau.example/api/3.22/sites/site", { headers: { "X-Tableau-Auth": runningToken } })).status).toBe(200);
  } finally {
    release();
    await queue.waitIdle();
    db.close();
  }
});
