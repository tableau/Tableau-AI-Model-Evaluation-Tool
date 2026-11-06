/**
 * The Color palettes suite runs from the tool alone.
 * (The catalog / launch / full-orchestrator parts live beside the server code:
 * `suites/catalog.test.ts`, `routes/nlq_eval.test.ts`, `job/orchestrator.test.ts`.)
 *
 * The server is a fake fetch, so the adapter's own request code (headers,
 * payload, retries, re-sign-in) is what runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAdapter,
  type RowPayload,
  type RunConfig,
  shareSession,
  type SuitePlan,
  type TableauSession,
  TableauSession as TableauSessionCls,
  unshareSession,
} from "@tableau-ai-eval/core";
import {
  MAX_ATTEMPTS,
  PaletteAdapter,
  requestUrl,
  sessionFor,
} from "./palettes.ts";

const SERVER = "https://tableau.example.com";
const URL_ = `${SERVER}/content-exploration/analytics-assistant/color-palettes/generate`;
const CONFIG: RunConfig = {
  adapter: "palettes",
  tableau_server: SERVER,
  ces_url: `${SERVER}/content-exploration`,
  tableau_site: "site",
  max_concurrency: 1,
  requests_per_minute: 60,
};

class FakeSession {
  token = "token-1";
  reauths = 0;
  async getToken(): Promise<string> {
    return this.token;
  }
  async handle401(_failed?: string | null): Promise<string> {
    this.reauths += 1;
    this.token = `token-${this.reauths + 1}`;
    return this.token;
  }
}

interface Req {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let dir: string;
let requests: Req[];
let handler: (req: Req) => Response;
let session: FakeSession | null;

function writeCase(
  name: string,
  id: string,
  utterance: string,
  paletteType: string,
  expected: string[] = [],
  runner = "color-palettes-server",
): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      runner,
      info: { version: "1.0.0" },
      inputs: [
        {
          utterance,
          source: "user",
          arguments: { palette_type: paletteType },
          expected: { colorPalette: expected },
        },
      ],
      id,
    }),
  );
}

const ok = (colors: string[] = ["#B22234", "#FFFFFF", "#3C3B6E"]) =>
  new Response(JSON.stringify({ colors }), { status: 200 });

function adapter(): PaletteAdapter {
  return new PaletteAdapter({
    fetchImpl: async (url, init) => {
      const req: Req = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      };
      requests.push(req);
      return handler(req);
    },
    sleep: async () => {},
    sessionFor: () => session as unknown as TableauSession | null,
  });
}

const cfg = (extra: RunConfig = {}): RunConfig => ({ ...CONFIG, test_path: dir, ...extra });

async function execute(
  plan: SuitePlan,
  opts: { stop?: () => string | null; completed?: Set<string>; config?: RunConfig } = {},
): Promise<RowPayload[]> {
  const rows: RowPayload[] = [];
  await adapter().execute(
    plan,
    opts.config ?? cfg(),
    async (r) => {
      rows.push(r);
    },
    opts.stop ?? (() => null),
    opts.completed ?? new Set(),
  );
  return rows;
}

const onlyA = new Set(["case-b", "case-c"]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "palettes-"));
  writeCase("a_regular.json", "case-a", "American flag colors", "regular", [
    "#FF0000",
    "#FFFFFF",
    "#0000FF",
  ]);
  writeCase("b_sequential.json", "case-b", "Ocean colors", "sequential");
  writeCase("c_diverging.json", "case-c", "Profit and loss", "diverging");
  requests = [];
  handler = () => ok();
  session = new FakeSession();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The suite ships with the tool
// ---------------------------------------------------------------------------

describe("loading", () => {
  test("the bundled suite loads without the evaluator", () => {
    const plan = adapter().load({ ...CONFIG });
    expect(plan.total).toBe(34);
    expect(new Set(plan.skeletons.map((s) => s.test_case_id)).size).toBe(34);
    expect(plan.conversation_ids).toEqual(plan.skeletons.map((s) => [s.test_case_id]));
    const types = (plan.opaque as { cases: { palette_type: string }[] }).cases.map(
      (c) => c.palette_type,
    );
    const count = (t: string) => types.filter((x) => x === t).length;
    expect([count("regular"), count("sequential"), count("diverging")]).toEqual([16, 11, 7]);
    for (const s of plan.skeletons) {
      expect(s.runner).toBe("color-palettes-server");
      expect(s.utterance).toBeTruthy();
      expect(Array.isArray(s.expected.colorPalette)).toBe(true);
    }
  });

  test("the registry resolves the adapter", async () => {
    await import("../index.ts");
    expect(await getAdapter({ adapter: "palettes" })).toBeInstanceOf(PaletteAdapter);
  });

  test("load skips unreadable files and other runners", () => {
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeCase("other.json", "case-x", "q", "regular", [], "ect-server");
    const plan = adapter().load(cfg());
    expect(plan.skeletons.map((s) => s.test_case_id)).toEqual(["case-a", "case-b", "case-c"]);
  });

  test("load fails when there is nothing to run", () => {
    const empty = mkdtempSync(join(tmpdir(), "palettes-empty-"));
    try {
      expect(() => adapter().load(cfg({ test_path: empty }))).toThrow(
        /No runnable Color palettes cases/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("a run without a server fails before it starts", () => {
    expect(() => adapter().session({ adapter: "palettes" }, "job")).toThrow(
      /Tableau Server connection/,
    );
  });

  test("the request URL follows the connection", () => {
    expect(requestUrl(CONFIG)).toBe(URL_);
    expect(requestUrl({ tableau_server: `${SERVER}/` })).toBe(URL_);
    // A development service started on its own has no /content-exploration root.
    expect(requestUrl({ ces_url: "http://localhost:8080" })).toBe(
      "http://localhost:8080/content-exploration/analytics-assistant/color-palettes/generate",
    );
  });
});

// ---------------------------------------------------------------------------
// Running cases
// ---------------------------------------------------------------------------

describe("execute", () => {
  test("sends each case and scores the answer", async () => {
    const plan = adapter().load(cfg());
    const rows = await execute(plan);
    expect(rows.map((r) => r.test_case_id)).toEqual(["case-a", "case-b", "case-c"]);
    const first = requests[0]!;
    expect(first.url).toBe(URL_);
    expect(first.headers["X-Tableau-Auth"]).toBe("token-1");
    expect(first.headers.Accept).toBe(
      "application/vnd.analytics-assistant.color-palettes.v1.0+json",
    );
    expect(first.body).toEqual({
      utterance: { content: "American flag colors" },
      paletteType: "regular",
    });

    const byId = Object.fromEntries(rows.map((r) => [r.test_case_id, r]));
    const regular = byId["case-a"]!;
    expect(regular.runner).toBe("color-palettes-server");
    expect(regular.errors).toEqual([]);
    expect(regular.actual).toEqual({
      colorPalette: ["#B22234", "#FFFFFF", "#3C3B6E"],
      paletteType: "regular",
    });
    expect(regular.expected).toEqual({ colorPalette: ["#FF0000", "#FFFFFF", "#0000FF"] });
    expect(regular.latency).not.toBeNull();
    expect(regular.latency!).toBeGreaterThanOrEqual(0);
    const names = (r: RowPayload) => r.metrics.colorPalette!.map((m) => m.metric_name);
    expect(names(regular)).toEqual(["distinguishability", "groundTruthValidity"]);
    expect(names(byId["case-b"]!)).toEqual(["gradientSmoothness"]);
    expect(names(byId["case-c"]!)).toEqual(["gradientSmoothness", "divergingStructure"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "actual", "datasource", "debug_info", "errors", "expected", "info",
          "latency", "metrics", "runner", "test_case_id", "turn", "utterance",
        ],
      );
    }
  });

  test("skips completed cases and stops on pause", async () => {
    const plan = adapter().load(cfg());
    let rows = await execute(plan, { completed: new Set(["case-a", "case-c"]) });
    expect(rows.map((r) => r.test_case_id)).toEqual(["case-b"]);

    let n = 0;
    rows = await execute(plan, { stop: () => (++n > 1 ? "pause" : null) });
    expect(rows.map((r) => r.test_case_id)).toEqual(["case-a"]);
  });

  test("case_started is reported", async () => {
    const plan = adapter().load(cfg());
    const started: string[] = [];
    plan.case_started = (id) => started.push(id);
    await execute(plan);
    expect(started).toEqual(["case-a", "case-b", "case-c"]);
  });

  test("a server error is retried, then recorded on the case", async () => {
    let busy = 2;
    handler = () =>
      busy-- > 0 ? new Response("gateway busy", { status: 503 }) : ok(["#000000", "#FFFFFF"]);
    const plan = adapter().load(cfg());
    let rows = await execute(plan, { completed: onlyA });
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.actual.colorPalette).toEqual(["#000000", "#FFFFFF"]);
    expect(requests.length).toBe(3);

    requests = [];
    handler = () => new Response("model gateway failed", { status: 500 });
    rows = await execute(plan, { completed: onlyA });
    expect(requests.length).toBe(MAX_ATTEMPTS);
    const row = rows[0]!;
    expect(row.actual).toEqual({});
    expect(row.metrics).toEqual({});
    expect(row.latency).toBeNull();
    expect(row.errors).toEqual([
      {
        phase: "RUN_TEST",
        description:
          "Tableau Server answered the palette request with HTTP 500: model gateway " +
          "failed. A 5xx is the site's AI model or its gateway, not the connection: " +
          "test it in Site Settings > AI in Tableau, then resume the evaluation.",
        warning: false,
      },
    ]);
  });

  test("a network failure reads as one", async () => {
    handler = () => {
      throw new Error("connection refused");
    };
    const plan = adapter().load(cfg());
    const row = (await execute(plan, { completed: onlyA }))[0]!;
    expect(requests.length).toBe(MAX_ATTEMPTS);
    expect(row.errors[0]!.description).toBe(
      "Tableau Server did not answer the palette request (network error: connection " +
        "refused). Check that this computer still reaches the server, then resume the " +
        "evaluation.",
    );
  });

  test("a lost session signs in again once", async () => {
    handler = (req) =>
      req.headers["X-Tableau-Auth"] === "token-1"
        ? new Response("session ended", { status: 401 })
        : ok(["#112233", "#DDEEFF"]);
    const plan = adapter().load(cfg());
    let row = (await execute(plan, { completed: onlyA }))[0]!;
    expect(row.errors).toEqual([]);
    expect(session!.reauths).toBe(1);
    expect(requests.map((r) => r.headers["X-Tableau-Auth"])).toEqual(["token-1", "token-2"]);

    // A token the server keeps refusing is reported, not retried for ever.
    requests = [];
    handler = () => new Response("no", { status: 401 });
    row = (await execute(plan, { completed: onlyA }))[0]!;
    expect(requests.length).toBe(2);
    expect(row.errors[0]!.description).toBe(
      "Tableau Server refused the palette request (HTTP 401): the session is gone or " +
        "the token has expired. Test the connection in Evaluation Setup, step 1, then " +
        "resume the evaluation. Server said: no",
    );
  });

  test("a feature that is off is said plainly and not retried", async () => {
    handler = () => new Response("Generate Palettes feature is not enabled.", { status: 501 });
    const plan = adapter().load(cfg());
    const rows = await execute(plan);
    expect(requests.length).toBe(3); // one request per case
    for (const row of rows) {
      expect(row.actual).toEqual({});
      expect(
        row.errors[0]!.description.startsWith(
          "Color palette generation is not enabled for this site on this server (501)",
        ),
      ).toBe(true);
    }
  });

  test("an answer without colors is an error, not a score", async () => {
    handler = () => new Response(JSON.stringify({ message: "no palette" }), { status: 200 });
    const plan = adapter().load(cfg());
    const row = (await execute(plan, { completed: onlyA }))[0]!;
    expect(row.actual).toEqual({});
    expect(row.metrics).toEqual({});
    expect(row.errors[0]!.phase).toBe("RUN_TEST");
    expect(row.errors[0]!.description).toBe(
      `The server's answer had no colors: {"message": "no palette"}`,
    );
  });

  test("an empty palette keeps the answer and says why it has no scores", async () => {
    handler = () => ok([]);
    const plan = adapter().load(cfg());
    const row = (await execute(plan, { completed: onlyA }))[0]!;
    expect(row.actual).toEqual({ colorPalette: [], paletteType: "regular" });
    expect(row.metrics).toEqual({});
    expect(row.errors.map((e) => e.phase)).toEqual(["EVALUATE_RESULT", "EVALUATE_RESULT"]);
  });

  test("without a session the development service address is used", async () => {
    session = null;
    const config: RunConfig = {
      adapter: "palettes",
      ces_url: "http://localhost:8080",
      test_path: dir,
      max_concurrency: 1,
      requests_per_minute: 60,
    };
    const plan = adapter().load(config);
    await execute(plan, { completed: onlyA, config });
    const req = requests[0]!;
    expect(req.headers["X-Tableau-Auth"]).toBeUndefined();
    expect(req.url.endsWith("/color-palettes/generate?overwrite=true&user=1&siteLuid=2&admin")).toBe(
      true,
    );
  });
});

test("the run's shared session is used rather than a second sign-in", () => {
  const shared = new TableauSessionCls({ serverUrl: SERVER, patName: "n", patSecret: "v" });
  shareSession("job-1", shared);
  try {
    const config = { ...CONFIG, tableau_pat_name: "n", tableau_pat_value: "v" };
    expect(sessionFor(config, "job-1")).toBe(shared);
    const own = sessionFor(config, "another-job");
    expect(own).toBeInstanceOf(TableauSessionCls);
    expect(own).not.toBe(shared);
    expect(sessionFor(CONFIG, "another-job")).toBeNull();
  } finally {
    unshareSession("job-1");
  }
});
