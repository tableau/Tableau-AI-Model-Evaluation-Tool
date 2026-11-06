import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  baseUrls,
  buildSession,
  createCabuClientFactory,
  createCabuSuiteLoader,
  parseSuiteYaml,
  resolveSuiteFile,
  verifyTls,
} from "./cabu_runner.ts";
import type { RunConfig } from "@tableau-ai-eval/core";
import type { FetchLike } from "../adapters/cabu/client.ts";

// ---------------------------------------------------------------------------
// Temp-fixture helper (no CWD coupling): each test that touches disk mints its
// own tmpdir and cleans it up afterwards.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
function mkSuiteDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cabu-suite-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// A synthetic CABU suite: {common, tests:[{input, tags}]}. The real
// suites fold `common` into each `input` via YAML anchors; here we write the
// merged `input` blocks directly (post-anchor shape), matching what the loader
// parses. Inputs carry PLACEHOLDER LUIDs by design (config overrides them).
const SUITE_YAML = `
common:
  workbook_luid: PLACEHOLDER
  datasource_luid: PLACEHOLDER
tests:
  - input:
      utteranceId: sales.total
      utterance: "What are total sales?"
      workbook_luid: PLACEHOLDER
      datasource_luid: PLACEHOLDER
      datasource_name: Superstore
      expected_output_types: ["DATA_QUESTION"]
      ground_truth_answer: "Total sales are $2.3M"
      follow_up_utterances:
        - "and by region?"
    tags: [smoke, sales]
  - input:
      utterance: "How many orders?"
      expected_output_types: ["DATA_QUESTION"]
    tags: [orders]
  - input:
      utteranceId: blank.case
      utterance: "   "
    tags: [skipme]
`;

// ---------------------------------------------------------------------------
// parseSuiteYaml
// ---------------------------------------------------------------------------

describe("cabu_runner — parseSuiteYaml", () => {
  test("parses a dashboard Q&A suite into CabuCase[] (id/tags/input shape)", () => {
    const cases = parseSuiteYaml(SUITE_YAML, "<synthetic>");
    // The blank-utterance case is dropped.
    expect(cases).toHaveLength(2);

    const [first, second] = cases;
    // id from utteranceId
    expect(first!.caseId).toBe("sales.total");
    expect(first!.tags).toEqual(["smoke", "sales"]);
    expect(first!.input.utterance).toBe("What are total sales?");
    expect(first!.input.datasource_name).toBe("Superstore");
    expect(first!.input.expected_output_types).toEqual(["DATA_QUESTION"]);
    expect(first!.input.ground_truth_answer).toBe("Total sales are $2.3M");
    expect(first!.input.follow_up_utterances).toEqual(["and by region?"]);
    // PLACEHOLDER LUIDs are preserved verbatim (config overrides them later).
    expect(first!.input.workbook_luid).toBe("PLACEHOLDER");

    // id derived from case.N when utteranceId is absent (index is 1-based over
    // the raw tests list, so the 2nd test is case.2).
    expect(second!.caseId).toBe("case.2");
    expect(second!.tags).toEqual(["orders"]);
  });

  test("de-duplicates colliding ids with a __dupN suffix", () => {
    const yaml = `
tests:
  - input: { utteranceId: dup, utterance: a }
  - input: { utteranceId: dup, utterance: b }
  - input: { utteranceId: dup, utterance: c }
`;
    const cases = parseSuiteYaml(yaml);
    expect(cases.map((c) => c.caseId)).toEqual(["dup", "dup__dup1", "dup__dup2"]);
  });

  test("falls back to input.tags when the test has no tags", () => {
    const yaml = `
tests:
  - input: { utterance: q, tags: [fromInput] }
`;
    const cases = parseSuiteYaml(yaml);
    expect(cases[0]!.tags).toEqual(["fromInput"]);
  });

  test("throws on YAML that is not a dashboard Q&A suite (no tests list)", () => {
    expect(() => parseSuiteYaml("common: {}\n", "<bad>")).toThrow(
      /not a dashboard Q&A suite YAML \(no 'tests' list\)/,
    );
    expect(() => parseSuiteYaml("- a\n- b\n")).toThrow(/no 'tests' list/);
    expect(() => parseSuiteYaml("")).toThrow(/no 'tests' list/);
  });

  test("throws on malformed YAML text", () => {
    // Unbalanced flow mapping — js-yaml raises a YAMLException.
    expect(() => parseSuiteYaml("tests: [ { unterminated: ")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveSuiteFile (path resolution, no CWD coupling)
// ---------------------------------------------------------------------------

// Questions about a dashboard is held back from this release and its
// public-suites/dashboard-qa folder is out of the tree; the three checks that
// read the shipped suite run again when it returns.
const SHIPPED_QA = existsSync(join(import.meta.dir, "..", "..", "..", "..", "public-suites", "dashboard-qa"));

describe("cabu_runner — resolveSuiteFile", () => {
  test("an absolute test_path naming a .yaml file wins outright", () => {
    const dir = mkSuiteDir();
    const file = join(dir, "explicit.yaml");
    writeFileSync(file, SUITE_YAML);
    const config: RunConfig = { test_path: file };
    expect(resolveSuiteFile(config, {})).toBe(file);
  });

  test("resolves a suite name under config.cabu_suites_root (tries name.yml)", () => {
    const dir = mkSuiteDir();
    const file = join(dir, "cabu_superstore.yml");
    writeFileSync(file, SUITE_YAML);
    // No test_path -> DEFAULT_SUITE "cabu_superstore" looked up in the root.
    const config: RunConfig = { cabu_suites_root: dir };
    expect(resolveSuiteFile(config, {})).toBe(file);
  });

  test("resolves a named suite via $TABLEAU_AI_EVAL_CABU_SUITES env", () => {
    const dir = mkSuiteDir();
    const file = join(dir, "mysuite.yaml");
    writeFileSync(file, SUITE_YAML);
    const config: RunConfig = { test_path: "mysuite" };
    expect(resolveSuiteFile(config, { TABLEAU_AI_EVAL_CABU_SUITES: dir })).toBe(file);
  });

  test("throws when no suites directory is configured and none ships", () => {
    const config: RunConfig = { test_path: "some_suite" };
    const nowhere = { TABLEAU_AI_EVAL_PUBLIC_SUITES: join(mkSuiteDir(), "absent") };
    expect(() => resolveSuiteFile(config, nowhere)).toThrow(
      /Dashboard Q&A suites not found: the tool's public-suites\/dashboard-qa folder is missing/,
    );
  });

  test.skipIf(!SHIPPED_QA)("finds the suite that ships with the tool by name", () => {
    // Default suite name, no cabu_suites_root/env: public-suites/dashboard-qa.
    const file = resolveSuiteFile({}, {});
    expect(file.split(/[\\/]/).slice(-4)).toEqual([
      "public-suites", "dashboard-qa", "cases", "cabu_superstore.yml",
    ]);
    // A configured suites dir is looked in first, the bundled one after.
    const dir = mkSuiteDir();
    writeFileSync(join(dir, "cabu_superstore.yml"), SUITE_YAML);
    expect(resolveSuiteFile({ cabu_suites_root: dir }, {})).toBe(join(dir, "cabu_superstore.yml"));
    expect(resolveSuiteFile({ test_path: "cabu_superstore", cabu_suites_root: mkSuiteDir() }, {})).toBe(file);
  });

  test.skipIf(!SHIPPED_QA)("the bundled suite: 422 portable cases, no workbook or datasource id baked in", async () => {
    const cases = await createCabuSuiteLoader({ env: {} })({ test_path: "cabu_superstore" });
    expect(cases).toHaveLength(422);
    expect(new Set(cases.map((c) => c.input.workbook_luid))).toEqual(new Set(["PLACEHOLDER"]));
    expect(new Set(cases.map((c) => c.input.datasource_luid))).toEqual(new Set(["PLACEHOLDER"]));
  });

  test.skipIf(!SHIPPED_QA)("throws when the named suite is absent from the suites directory", () => {
    const dir = mkSuiteDir();
    const config: RunConfig = { test_path: "missing", cabu_suites_root: dir };
    expect(() => resolveSuiteFile(config, {})).toThrow(/CABU suite not found/);
    // Both places are named.
    expect(() => resolveSuiteFile(config, {})).toThrow(/dashboard-qa/);
  });
});

// ---------------------------------------------------------------------------
// createCabuSuiteLoader (end-to-end resolve + read + parse)
// ---------------------------------------------------------------------------

describe("cabu_runner — createCabuSuiteLoader", () => {
  test("loads + parses a temp suite file into cases (real disk read)", async () => {
    const dir = mkSuiteDir();
    const file = join(dir, "loadme.yaml");
    writeFileSync(file, SUITE_YAML);
    const loader = createCabuSuiteLoader({ env: {} });
    const cases = await loader({ test_path: file });
    expect(cases.map((c) => c.caseId)).toEqual(["sales.total", "case.2"]);
  });

  test("uses injected readFile — resolveSuiteFile locates, readFile supplies text", async () => {
    // resolveSuiteFile still stats the .yml path (it must exist on disk), but
    // the file *contents* come from the injected readFile, so the parsed cases
    // are independent of what is actually written to disk.
    const dir = mkSuiteDir();
    const file = join(dir, "ondisk.yml");
    writeFileSync(file, "tests: []\n"); // real file exists but is empty-of-cases
    let readPath = "";
    const loader = createCabuSuiteLoader({
      readFile: (p) => {
        readPath = p;
        return SUITE_YAML; // inject the richer suite text
      },
      env: {},
    });
    const cases = await loader({ test_path: file });
    expect(readPath).toBe(file);
    expect(cases).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// baseUrls + verifyTls
// ---------------------------------------------------------------------------

describe("cabu_runner — baseUrls + verifyTls", () => {
  test("baseUrls prefers cabu_base_url, then ces_url, then derives from server", () => {
    expect(baseUrls({ cabu_base_url: "https://h/ce/" })).toEqual({
      baseUrl: "https://h/ce",
      loginBaseUrl: "https://h/ce",
    });
    expect(baseUrls({ ces_url: "https://h/other" }).baseUrl).toBe("https://h/other");
    expect(baseUrls({ tableau_server: "https://srv/" })).toEqual({
      baseUrl: "https://srv/content-exploration",
      loginBaseUrl: "https://srv",
    });
  });

  test("baseUrls throws when neither base nor server present", () => {
    expect(() => baseUrls({})).toThrow(/needs 'cabu_base_url'/);
  });

  test("verifyTls: explicit cabu_verify_tls overrides verify_tls", () => {
    expect(verifyTls({ cabu_base_url: "https://h/ce", cabu_verify_tls: false })).toBe(false);
    expect(
      verifyTls({ cabu_base_url: "https://h/ce", cabu_verify_tls: true, verify_tls: false }),
    ).toBe(true);
  });

  test("verifyTls: defaults off for localhost, on otherwise", () => {
    expect(verifyTls({ cabu_base_url: "https://localhost:8080/ce" })).toBe(false);
    expect(verifyTls({ cabu_base_url: "https://127.0.0.1/ce" })).toBe(false);
    expect(verifyTls({ cabu_base_url: "https://prod.example/ce" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSession (per-run auth, no import-time creds)
// ---------------------------------------------------------------------------

describe("cabu_runner — buildSession", () => {
  test("returns null when PAT fields are incomplete", () => {
    expect(buildSession({})).toBeNull();
    expect(buildSession({ tableau_pat_name: "n", tableau_server: "https://s" })).toBeNull();
    expect(
      buildSession({ tableau_pat_name: "n", tableau_pat_value: "v" }),
    ).toBeNull();
  });

  test("builds a TableauSession from server/PAT/site + injected fetch", async () => {
    let signinUrl = "";
    const fakeFetch: FetchLike = async (input) => {
      signinUrl = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({ credentials: { token: "TOK", site: { id: "SITE" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const session = buildSession(
      {
        tableau_server: "https://srv",
        tableau_pat_name: "pn",
        tableau_pat_value: "pv",
        tableau_site: "mysite",
        // Pin ca_bundle_path so buildSession never resolves ~/.tableau-ai-eval/ca.pem.
        ca_bundle_path: "",
      },
      fakeFetch,
    );
    expect(session).not.toBeNull();
    // Minting the token exercises the injected fetch (no live call).
    const token = await session!.getToken();
    expect(token).toBe("TOK");
    expect(session!.cachedSiteId).toBe("SITE");
    expect(signinUrl).toBe("https://srv/api/3.22/auth/signin");
  });
});

// ---------------------------------------------------------------------------
// createCabuClientFactory (PAT path + signin path)
// ---------------------------------------------------------------------------

describe("cabu_runner — createCabuClientFactory", () => {
  test("PAT path: mints a session token and injects authToken + siteLuid", async () => {
    const requests: string[] = [];
    const fakeFetch: FetchLike = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);
      if (url.endsWith("/auth/signin")) {
        return new Response(
          JSON.stringify({ credentials: { token: "PATTOK", site: { id: "PATSITE" } } }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    };
    const factory = createCabuClientFactory({ fetchImpl: fakeFetch });
    const client = await factory({
      tableau_server: "https://srv",
      tableau_pat_name: "pn",
      tableau_pat_value: "pv",
      tableau_site: "site",
      cabu_base_url: "https://srv/content-exploration",
      ca_bundle_path: "",
    });
    expect(client.authToken).toBe("PATTOK");
    expect(client.siteLuid).toBe("PATSITE");
    // Only the signin round-trip happened (no client.login()).
    expect(requests).toEqual(["https://srv/api/3.22/auth/signin"]);
  });

  test("signin path: no PAT -> uses cabu_username/password + tableau_site via login()", async () => {
    const requests: string[] = [];
    const fakeFetch: FetchLike = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);
      if (url.endsWith("/auth/signin")) {
        return new Response(
          `<tsResponse><credentials token="LOGTOK"><site id="LOGSITE"/><user id="U"/></credentials></tsResponse>`,
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    };
    const factory = createCabuClientFactory({ fetchImpl: fakeFetch });
    const client = await factory({
      cabu_base_url: "https://host/content-exploration",
      cabu_login_base_url: "https://host",
      cabu_username: "u",
      cabu_password: "p",
      tableau_site: "site",
    });
    // The client's own XML signin populated auth state.
    expect(client.authToken).toBe("LOGTOK");
    expect(client.siteLuid).toBe("LOGSITE");
    expect(requests).toEqual(["https://host/api/3.4/auth/signin"]);
  });

  test("throws when neither PAT nor signin creds are present", async () => {
    const factory = createCabuClientFactory({
      fetchImpl: async () => new Response("nf", { status: 404 }),
    });
    await expect(factory({ cabu_base_url: "https://h/ce" })).rejects.toThrow(
      /CABU auth needs either/,
    );
  });

  test("respects an injected sessionFactory (bypasses PAT field detection)", async () => {
    const requests: string[] = [];
    const fakeFetch: FetchLike = async (input) => {
      requests.push(typeof input === "string" ? input : input.toString());
      return new Response("nf", { status: 404 });
    };
    // Fake session: no network, canned token + site.
    const fakeSession = {
      getToken: async () => "INJTOK",
      cachedSiteId: "INJSITE",
    };
    const factory = createCabuClientFactory({
      fetchImpl: fakeFetch,
      sessionFactory: () => fakeSession as never,
    });
    const client = await factory({ cabu_base_url: "https://h/ce" });
    expect(client.authToken).toBe("INJTOK");
    expect(client.siteLuid).toBe("INJSITE");
    // No fetch calls at all — the injected session short-circuits auth.
    expect(requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full loader -> client -> one-case path with a single injected fetch that
// serves both the PAT signin and the three CABU phases. Proves the wiring end
// to end without a live server.
// ---------------------------------------------------------------------------

function cabuSse(utterance: string): string {
  return [
    "event: classification_complete",
    'data: {"utteranceType":"DATA_QUESTION"}',
    "",
    "event: response_complete",
    `data: {"response":"reply to ${utterance}","chatLuid":"chat1"}`,
    "",
    "event: complete",
    "data: {}",
    "",
  ].join("\n");
}

describe("cabu_runner — full loader -> client -> one case (injected fetch)", () => {
  test("loads a suite, builds a PAT client, and drives one case to a stream", async () => {
    const dir = mkSuiteDir();
    const file = join(dir, "e2e.yaml");
    writeFileSync(file, SUITE_YAML);

    let lastUtterance = "";
    const fakeFetch: FetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/signin")) {
        return new Response(
          JSON.stringify({ credentials: { token: "TOK", site: { id: "SITE" } } }),
          { status: 200 },
        );
      }
      if (url.endsWith("/conversations")) {
        return new Response(
          JSON.stringify({ conversationId: "conv1", scope: "sc", sdmNames: ["sdm1"] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/utterances")) {
        lastUtterance = JSON.parse(String(init!.body)).utterance.content;
        return new Response(JSON.stringify({ utteranceId: "utt1", b3TraceId: "b3" }), {
          status: 200,
        });
      }
      if (url.endsWith("/stream")) {
        return new Response(cabuSse(lastUtterance), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("nf", { status: 404 });
    };

    const config: RunConfig = {
      test_path: file,
      tableau_server: "https://srv",
      tableau_pat_name: "pn",
      tableau_pat_value: "pv",
      tableau_site: "site",
      cabu_base_url: "https://srv/content-exploration",
      workbook_luid: "wb1",
      datasource_luid: "ds1",
      ca_bundle_path: "",
    };

    const loader = createCabuSuiteLoader({ env: {} });
    const cases = await loader(config);
    expect(cases).toHaveLength(2);

    const factory = createCabuClientFactory({ fetchImpl: fakeFetch, uuidHex: () => "t" });
    const shared = await factory(config);
    expect(shared.authToken).toBe("TOK");

    // Drive phase 1-3 for the first case (mirrors CabuAdapter.runCase's core).
    const client = shared.childClient();
    await client.createConversation({
      workbookLuid: config.workbook_luid as string,
      dashboardDatasources: [{ datasourceLuid: config.datasource_luid as string }],
      wgSessionId: client.authToken,
    });
    await client.postUtterance({
      utterance: cases[0]!.input.utterance as string,
      wgSessionId: client.authToken,
    });
    const events = await client.streamConversation();

    expect(client.getFinalAnswer(events)).toBe("reply to What are total sales?");
    expect(client.getUtteranceType(events)).toBe("DATA_QUESTION");
    expect(client.getChatLuid(events)).toBe("chat1");
  });
});
