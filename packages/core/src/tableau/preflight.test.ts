import { test, expect } from "bun:test";
import {
  runPreflight,
  probeServerinfo,
  probeGenerations,
  identifyModel,
  skippedStage,
  FLAG_OFF_MESSAGE,
  CES_GENERATIONS_PATH,
  CABU_CONVERSATIONS_PATH,
  PALETTES_GENERATE_PATH,
  type PreflightConfig,
  serverVersionLabel,
} from "./preflight.ts";

/**
 * A routing mock fetch keyed by URL substring → responder. Records requests so
 * tests can assert probe order and that secrets never leave the process.
 */
function router(
  routes: Array<[string, (url: string, init: RequestInit) => Response]>,
): { fn: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    for (const [needle, responder] of routes) {
      if (url.includes(needle)) return responder(url, init ?? {});
    }
    throw new Error(`no route for ${url}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseConfig: PreflightConfig = {
  tableau_server: "https://tab.example.com",
  tableau_site: "MySite",
  tableau_pat_name: "pat",
  tableau_pat_value: "secret-value",
  ces_url: "https://tab.example.com/content-exploration",
  verify_tls: false,
};

test("probeServerinfo returns version on 200", async () => {
  const { fn } = router([
    [
      "serverinfo",
      () =>
        json({
          serverInfo: {
            productVersion: { value: "2026.3.0" },
            restApiVersion: "3.25",
          },
        }),
    ],
  ]);
  const s = await probeServerinfo("https://tab.example.com", "3.22", { verify: false }, fn);
  expect(s.ok).toBe(true);
  expect(s.product_version).toBe("2026.3.0");
  expect(s.rest_api_version).toBe("3.25");
});

test("probeServerinfo flags unreachable on network error", async () => {
  const fn = (async () => {
    throw new Error("ENOTFOUND");
  }) as unknown as typeof fetch;
  const s = await probeServerinfo("https://unreachable.example.com", "3.22", { verify: false }, fn);
  expect(s.ok).toBe(false);
  expect(s.reason).toBe("unreachable");
  expect(s.message).toContain("not reachable");
});

test("probeServerinfo flags a TLS verification failure as a certificate problem", async () => {
  const errByMessage = (async () => {
    throw new Error(
      "fetch failed: certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)",
    );
  }) as unknown as typeof fetch;
  const s1 = await probeServerinfo("https://tab.example.com", "3.22", { verify: true }, errByMessage);
  expect(s1.ok).toBe(false);
  expect(s1.reason).toBe("certificate");
  expect(s1.message).toContain("self-signed certificate in certificate chain");
  expect(s1.message).toContain("browser");

  const errByCode = (async () => {
    const e = new Error("unable to verify the first certificate") as Error & { code: string };
    e.code = "SELF_SIGNED_CERT_IN_CHAIN";
    throw e;
  }) as unknown as typeof fetch;
  const s2 = await probeServerinfo("https://tab.example.com", "3.22", { verify: true }, errByCode);
  expect(s2.ok).toBe(false);
  expect(s2.reason).toBe("certificate");
});

test("probeServerinfo flags non-200 as not-a-Tableau-URL", async () => {
  const { fn } = router([["serverinfo", () => new Response("html", { status: 404 })]]);
  const s = await probeServerinfo("https://tab.example.com", "3.22", { verify: false }, fn);
  expect(s.ok).toBe(false);
  expect(s.status_code).toBe(404);
});

test("full preflight happy path: server → signin → generations 200", async () => {
  const { fn, calls } = router([
    [
      "serverinfo",
      () => json({ serverInfo: { productVersion: { value: "2026.3" } } }),
    ],
    [
      "auth/signin",
      () => json({ credentials: { token: "tok-1", site: { id: "site-luid" } } }),
    ],
    ["sites/site-luid", () => json({ site: { siteSettings: [] } })],
    [
      CES_GENERATIONS_PATH,
      () => json({ generations: [{ text: "I am Claude, made by Anthropic." }] }),
    ],
  ]);

  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(true);
  expect(result.server.ok).toBe(true);
  expect(result.session.ok).toBe(true);
  expect(result.session.site_id).toBe("site-luid");
  // The token must never be leaked back to callers.
  expect(result.session).not.toHaveProperty("_token");
  expect(result.generations.ok).toBe(true);
  expect(result.generations.model_family).toBe("anthropic");

  // Probe order: serverinfo first, signin second, generations last.
  const order = calls.map((c) =>
    c.url.includes("serverinfo")
      ? "serverinfo"
      : c.url.includes("auth/signin")
        ? "signin"
        : c.url.includes(CES_GENERATIONS_PATH)
          ? "generations"
          : c.url.includes(CABU_CONVERSATIONS_PATH)
            ? "dashboard_qa"
            : c.url.includes(PALETTES_GENERATE_PATH)
              ? "web_authoring"
              : "sitesettings",
  );
  expect(order[0]).toBe("serverinfo");
  expect(order).toContain("signin");
  // The site-switch probes follow the generations probe: Dashboards, then Authoring.
  expect(order.slice(-3)).toEqual(["generations", "dashboard_qa", "web_authoring"]);
});

test("the Dashboard Q&A probe reads the site setting from the refusal", async () => {
  // Tableau Agent in Dashboards has its own switch: a 403 naming the site
  // setting means off, any other answer from the endpoint means on, a 404
  // means the build has no endpoint. The verdict never fails the connection.
  const wire = (qa: () => Response) =>
    router([
      ["serverinfo", () => json({ serverInfo: { productVersion: { value: "2026.3" } } })],
      ["auth/signin", () => json({ credentials: { token: "tok-1", site: { id: "site-luid" } } })],
      ["sites/site-luid", () => json({ site: { siteSettings: [] } })],
      [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
      [CABU_CONVERSATIONS_PATH, qa],
    ]);

  const off = wire(
    () =>
      new Response(
        '{"errorMsg":"403 The Tableau Agent Dashboard site setting is not enabled for this site."}',
        { status: 403 },
      ),
  );
  const result = await runPreflight(baseConfig, off.fn);
  expect(result.ok).toBe(true);
  expect(result.dashboard_qa?.enabled).toBe(false);
  expect(result.dashboard_qa?.reason).toBe("site_setting_off");
  expect(result.dashboard_qa?.message).toContain("Site Settings");
  const probe = off.calls.find((c) => c.url.includes(CABU_CONVERSATIONS_PATH))!;
  expect(probe.url).toBe("https://tab.example.com/content-exploration/analytics-assistant/cabu/conversations");
  expect((probe.init.headers as Record<string, string>)["X-Tableau-Auth"]).toBe("tok-1");
  expect(JSON.parse(String(probe.init.body)).workbookLuid).toBe("00000000-0000-0000-0000-000000000000");

  const on = wire(() => new Response('{"errorMsg":"workbook not found"}', { status: 400 }));
  expect((await runPreflight(baseConfig, on.fn)).dashboard_qa?.enabled).toBe(true);

  const missing = wire(() => new Response("", { status: 404 }));
  const qa = (await runPreflight(baseConfig, missing.fn)).dashboard_qa!;
  expect(qa.enabled).toBe(false);
  expect(qa.reason).toBe("not_found");
});

test("the Tableau Agent in Authoring probe reads the site setting from the palette endpoint", async () => {
  // The palette endpoint checks the site setting before it looks at the
  // utterance, so a palette request with no utterance says whether the switch
  // is on (400 for the missing utterance) or off (403 naming the site setting)
  // without a model call. A 501 says the palette feature is off on that build
  // and nothing about the switch. The verdict never fails the connection.
  const wire = (palettes: () => Response) =>
    router([
      ["serverinfo", () => json({ serverInfo: { productVersion: { value: "2026.3" } } })],
      ["auth/signin", () => json({ credentials: { token: "tok-1", site: { id: "site-luid" } } })],
      ["sites/site-luid", () => json({ site: { siteSettings: [] } })],
      [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
      [CABU_CONVERSATIONS_PATH, () => new Response('{"errorMsg":"workbook not found"}', { status: 400 })],
      [PALETTES_GENERATE_PATH, palettes],
    ]);

  const off = wire(
    () =>
      new Response(
        '{"errorMsg":"403 The Tableau Agent Viz Authoring site setting is not enabled for this site."}',
        { status: 403 },
      ),
  );
  const result = await runPreflight(baseConfig, off.fn);
  expect(result.ok).toBe(true);
  expect(result.web_authoring?.enabled).toBe(false);
  expect(result.web_authoring?.reason).toBe("site_setting_off");
  expect(result.web_authoring?.message).toContain("Site Settings");
  const probe = off.calls.find((c) => c.url.includes(PALETTES_GENERATE_PATH))!;
  expect(probe.url).toBe("https://tab.example.com/content-exploration/analytics-assistant/color-palettes/generate");
  expect((probe.init.headers as Record<string, string>)["X-Tableau-Auth"]).toBe("tok-1");
  // No utterance: the request stops at the switch, before any model call.
  expect(JSON.parse(String(probe.init.body))).toEqual({ utterance: { content: "" }, paletteType: "regular" });

  const on = wire(() => new Response('{"errorMsg":"400 Missing utterance content."}', { status: 400 }));
  expect((await runPreflight(baseConfig, on.fn)).web_authoring?.enabled).toBe(true);

  const flagOff = wire(() => new Response('{"errorMsg":"Generate Palettes feature is not enabled."}', { status: 501 }));
  const unknown = (await runPreflight(baseConfig, flagOff.fn)).web_authoring!;
  expect(unknown.enabled).toBeNull();
  expect(unknown.reason).toBe("flag_off");
});

test("Site Settings' own web-authoring switch answers when the palette probe cannot", async () => {
  const wire = (settings: Array<{ key: string; value: string }>) =>
    router([
      ["serverinfo", () => json({ serverInfo: { productVersion: { value: "2026.3" } } })],
      ["auth/signin", () => json({ credentials: { token: "tok-1", site: { id: "site-luid" } } })],
      ["sites/site-luid", () => json({ site: { siteSettings: settings } })],
      [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
      [CABU_CONVERSATIONS_PATH, () => new Response('{"errorMsg":"workbook not found"}', { status: 400 })],
      [PALETTES_GENERATE_PATH, () => new Response("", { status: 404 })],
    ]);
  const model = { key: "generativeAiVizAndCalcGenerationModel", value: "claude-sonnet-5" };
  const off = await runPreflight(baseConfig, wire([model, { key: "generativeaiWebauthoringOnPremEnabled", value: "false" }]).fn);
  expect(off.web_authoring?.enabled).toBe(false);
  expect(off.web_authoring?.reason).toBe("site_setting_off");
  const on = await runPreflight(baseConfig, wire([model, { key: "generativeAiWebAuthoring", value: "true" }]).fn);
  expect(on.web_authoring?.enabled).toBe(true);
  const silent = await runPreflight(baseConfig, wire([model]).fn);
  expect(silent.web_authoring?.enabled).toBeNull();
  expect(silent.web_authoring?.reason).toBe("not_found");
});

test("site models fall back to the server's REST version", async () => {
  // A 2026.3 server has no REST 3.31 (404); the same settings are read at the
  // version serverinfo reported, so the model under test is still named.
  const { fn, calls } = router([
    [
      "serverinfo",
      () => json({ serverInfo: { productVersion: { value: "2026.3.0" }, restApiVersion: "3.30" } }),
    ],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "site-luid" } } })],
    ["/api/3.31/sites/site-luid", () => new Response("not found", { status: 404 })],
    [
      "/api/3.30/sites/site-luid",
      () =>
        json({
          site: {
            siteSettings: [{ key: "generativeAiVizAndCalcGenerationModel", value: "claude-sonnet-4-6" }],
          },
        }),
    ],
    [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(true);
  expect((result.site as { model_under_test?: unknown }).model_under_test).toBe("claude-sonnet-4-6");
  const siteCalls = calls.filter((c) => c.url.includes("/sites/site-luid"));
  expect(siteCalls[0]!.url).toEndWith("/api/3.31/sites/site-luid");
  expect(siteCalls[1]!.url).toEndWith("/api/3.30/sites/site-luid");
});

test("Site Settings' switch stands in when the Dashboard Q&A endpoint cannot tell", async () => {
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: { productVersion: { value: "2026.3" } } })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    [
      "sites/s1",
      () =>
        json({
          site: {
            siteSettings: [
              { key: "generativeAiVizAndCalcGenerationModel", value: "claude-sonnet-5" },
              { key: "dashboardQAEnabled", value: "true" },
            ],
          },
        }),
    ],
    [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
    [CABU_CONVERSATIONS_PATH, () => new Response("nope", { status: 401 })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect((result.site as { dashboard_qa_enabled?: unknown }).dashboard_qa_enabled).toBe(true);
  expect(result.dashboard_qa?.enabled).toBe(true);
});

test("a Dashboard Q&A service failure is reported but keeps the feature on", async () => {
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: { productVersion: { value: "2026.3" } } })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
    [
      CABU_CONVERSATIONS_PATH,
      () => json({ errorMsg: "502 WAII AddConnection failed: WAII service not available" }, 502),
    ],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(true);
  const qa = result.dashboard_qa!;
  expect(qa.enabled).toBe(true);
  expect(qa.ok).toBe(false);
  expect(qa.reason).toBe("service_unavailable");
  expect(qa.message).toContain("WAII service not available");
});

test("preflight stops at serverinfo failure", async () => {
  const { fn, calls } = router([["serverinfo", () => new Response("", { status: 500 })]]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(false);
  expect(result.server.ok).toBe(false);
  expect(result.session.reason).toBe("skipped");
  // Only serverinfo was called — no signin attempted with the PAT.
  expect(calls.length).toBe(1);
});

test("preflight surfaces PAT invalid (signin 401) distinctly", async () => {
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: {} })],
    ["auth/signin", () => new Response("bad pat", { status: 401 })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(false);
  expect(result.session.ok).toBe(false);
  expect(result.session.reason).toBe("pat_invalid");
});

test("generations 401 after valid session => flag_off (not a session problem)", async () => {
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: {} })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => new Response("no", { status: 401 })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(false);
  expect(result.session.ok).toBe(true);
  expect(result.generations.reason).toBe("flag_off");
  expect(result.generations.message).toBe(FLAG_OFF_MESSAGE);
});

test("generations 404 => server too old, no release named (dev build)", async () => {
  // A development build reports "0.0.0", so the 404 from the endpoint is the
  // only evidence: the verdict is "too old" with no release named.
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: {} })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => new Response("", { status: 404 })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(false);
  expect(result.connection_ok).toBe(true);
  expect(result.generations.reason).toBe("server_too_old");
  expect(result.generations.status_code).toBe(404);
  expect(result.generations.message).toContain("earlier than 2026.3");
  expect(result.server_too_old?.release).toBeNull();
  expect(result.server_too_old?.min_release).toBe("2026.3");
  expect(result.server_too_old?.message).toContain("Upgrade the server to 2026.3");
});

const SERVERINFO_OLD = {
  serverInfo: {
    productVersion: { value: "2025.3.2", build: "20253.26.0115.0900" },
    restApiVersion: "3.26",
  },
};

test("a release before 2026.3 is reported on the server stage", async () => {
  // Sign-in is still checked (the connection is worth saving for publishing)
  // and the verdict names the release and what to do.
  const { fn, calls } = router([
    ["serverinfo", () => json(SERVERINFO_OLD)],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => new Response("", { status: 404 })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.server.ok).toBe(true);
  expect(result.server.release).toBe("2025.3");
  expect(result.server.release_supported).toBe(false);
  expect(result.server.message).toContain("2026.3 or later");
  expect(result.session.ok).toBe(true);
  expect(calls.some((c) => c.url.includes(CES_GENERATIONS_PATH))).toBe(true);
  // Both endpoints are still probed: Dashboard Q&A is not behind the release gate.
  expect(calls.some((c) => c.url.includes(CABU_CONVERSATIONS_PATH))).toBe(true);
  expect(result.ok).toBe(false);
  expect(result.connection_ok).toBe(true);
  const tooOld = result.server_too_old!;
  expect(tooOld.release).toBe("2025.3");
  expect(tooOld.message).toContain("Tableau Server 2025.3 is earlier than 2026.3");
  expect(tooOld.message).toContain("published");
  expect(result.generations.message).toBe(tooOld.message);
});

test("a supported release and a dev build are not too old", async () => {
  let last: Awaited<ReturnType<typeof runPreflight>> | undefined;
  for (const info of [
    { serverInfo: { productVersion: { value: "2026.3.0", build: "20263.26.0930.1736" } } },
    { serverInfo: { productVersion: { value: "0.0.0", build: "main.26.0930.1736" } } },
  ]) {
    const { fn } = router([
      ["serverinfo", () => json(info)],
      ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
      ["sites/s1", () => json({ site: { siteSettings: [] } })],
      [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
    ]);
    last = await runPreflight(baseConfig, fn);
    expect(last.ok).toBe(true);
    expect(last.server_too_old).toBeUndefined();
  }
  expect(last!.server.release_supported).toBeNull(); // the dev build does not say
});

test("a probe that answers overrides an old-looking version", async () => {
  const { fn } = router([
    ["serverinfo", () => json(SERVERINFO_OLD)],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "pong" }] })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.ok).toBe(true);
  expect(result.server_too_old).toBeUndefined();
});

test("blank ces_url now derives from tableau_server and PROBES generations", async () => {
  const { fn, calls } = router([
    ["serverinfo", () => json({ serverInfo: {} })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [
      CES_GENERATIONS_PATH,
      () => json({ generations: [{ text: "I am Claude, made by Anthropic." }] }),
    ],
  ]);
  // No ces_url supplied — it must be derived as
  // <tableau_server>/content-exploration and actually probed.
  const result = await runPreflight({ ...baseConfig, ces_url: undefined }, fn);
  expect(result.ok).toBe(true);
  expect(result.session.ok).toBe(true);
  expect(result.generations.ok).toBe(true);
  expect(result.generations.model_family).toBe("anthropic");
  // The generations call went to the derived CES base.
  const gen = calls.find((c) => c.url.includes(CES_GENERATIONS_PATH));
  expect(gen).toBeDefined();
  expect(gen!.url).toContain(
    "https://tab.example.com/content-exploration" + CES_GENERATIONS_PATH,
  );
});

test("a truly-skipped generations stage does not read as a broken connection", () => {
  // The neutral-skip contract (see preflight header): a skipped generations
  // stage is informational — ok:false BUT state:"skipped" + skipped:true — and
  // MUST NOT be treated as a connection failure. Because runPreflight now
  // always derives ces_url from the (required) tableau_server, this stage is
  // only produced in the rare no-derive path; assert its documented shape.
  const s = skippedStage(
    "No ces_url could be determined — session validated, generations endpoint not probed.",
  );
  expect(s.ok).toBe(false);
  expect(s.state).toBe("skipped");
  expect(s.skipped).toBe(true);
  expect(s.reason).toBe("skipped");
  // The route layer's failed-stage detection ignores skipped stages (reason
  // "skipped"), so a connection with server ✅ / session ✅ / generations ⏭️
  // is reported usable rather than as a hard failure.
});

test("real generations failure still fails hard when ces_url is probed", async () => {
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: {} })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => new Response("no", { status: 401 })],
  ]);
  // Derived ces_url is probed and 401s => flag_off, a genuine failure.
  const result = await runPreflight({ ...baseConfig, ces_url: undefined }, fn);
  expect(result.session.ok).toBe(true);
  expect(result.generations.ok).toBe(false);
  expect(result.generations.state).toBe("failed");
  expect(result.generations.reason).toBe("flag_off");
  expect(result.ok).toBe(false);
});

test("missing tableau_server => required error", async () => {
  const fn = (async () => {
    throw new Error("should not fetch");
  }) as unknown as typeof fetch;
  const result = await runPreflight({}, fn);
  expect(result.server.reason).toBe("missing");
});

test("family mismatch is surfaced when site declares a different family", async () => {
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: {} })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    [
      "sites/s1",
      () =>
        json({
          site: {
            siteSettings: [
              {
                key: "generativeAiVizAndCalcGenerationModel",
                value: "gpt-4o",
              },
            ],
          },
        }),
    ],
    [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "I am Claude." }] })],
  ]);
  const result = await runPreflight(baseConfig, fn);
  expect(result.generations.family_mismatch).toEqual({
    site_settings: "gpt-4o",
    gateway_answered: "anthropic",
  });
});

test("probeGenerations reports unreachable on network error", async () => {
  const fn = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const s = await probeGenerations("https://ces.example.com", "tok", { verify: false }, fn);
  expect(s.ok).toBe(false);
  expect(s.reason).toBe("unreachable");
});

test("probeGenerations retries once on 5xx then succeeds", async () => {
  let n = 0;
  const { fn } = router([
    [
      CES_GENERATIONS_PATH,
      () => {
        n += 1;
        return n === 1
          ? json({ message: "LLM Gateway generations failed" }, 500)
          : json({ generations: [{ text: "Claude, by Anthropic" }] });
      },
    ],
  ]);
  const s = await probeGenerations("https://s/content-exploration", "tok", { verify: false }, fn, 0);
  expect(s.ok).toBe(true);
  expect(n).toBe(2);
});

test("probeGenerations on persistent 5xx points at the gateway", async () => {
  let n = 0;
  const { fn } = router([
    [
      CES_GENERATIONS_PATH,
      () => {
        n += 1;
        return json({ message: "LLM Gateway generations failed" }, 500);
      },
    ],
  ]);
  const s = await probeGenerations("https://s/content-exploration", "tok", { verify: false }, fn, 0);
  expect(s.ok).toBe(false);
  expect(s.reason).toBe("gateway_error");
  expect(n).toBe(2);
  expect(s.message).toContain("Site Settings");
  expect(s.message).toContain("not your connection");
});

test("downstream stages say why they were not run (blocked_by)", async () => {
  // Server ok, sign-in fails → generations must name the blocking stage.
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: { productVersion: { value: "2026.3" } } })],
    ["auth/signin", () => json({ error: "invalid PAT" }, 401)],
  ]);
  const result = await runPreflight(baseConfig, fn, 0);
  expect(result.generations.reason).toBe("skipped");
  expect(result.generations.blocked_by).toBe("PAT sign-in");
  expect(result.generations.message).toContain("PAT sign-in failed");

  // No server → both downstream stages blocked by "Server reachable".
  const noFetch = (async () => {
    throw new Error("should not fetch");
  }) as unknown as typeof fetch;
  const r2 = await runPreflight({}, noFetch, 0);
  expect(r2.session.blocked_by).toBe("Server reachable");
  expect(r2.generations.message).toContain("not attempted");
});

test("an unconfigured site (no models) is named as the cause of a gateway 500", async () => {
  const { fn } = router([
    ["serverinfo", () => json({ serverInfo: { productVersion: { value: "2026.3" } } })],
    ["auth/signin", () => json({ credentials: { token: "tok", site: { id: "site-1" } } })],
    // site models: no siteSettings → no models configured
    ["sites/site-1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => json({ message: "LLM Gateway generations failed" }, 500)],
  ]);
  const result = await runPreflight(baseConfig, fn, 0);
  expect(result.generations.reason).toBe("site_unconfigured");
  expect(result.generations.message).toContain("no AI models configured");
});

test("identifyModel maps markers to families", () => {
  expect(identifyModel("Claude here").model_family).toBe("anthropic");
  expect(identifyModel("gpt-4o").model_family).toBe("openai");
  expect(identifyModel("Gemini Pro").model_family).toBe("gemini");
  expect(identifyModel("some unknown model").model_family).toBeNull();
});

test("ca_bundle_path threads a tls.ca option through every probe (verify on)", async () => {
  const { fn, calls } = router([
    ["serverinfo", () => json({ serverInfo: {} })],
    ["auth/signin", () => json({ credentials: { token: "t", site: { id: "s1" } } })],
    ["sites/s1", () => json({ site: { siteSettings: [] } })],
    [CES_GENERATIONS_PATH, () => json({ generations: [{ text: "Claude" }] })],
  ]);
  await runPreflight(
    {
      ...baseConfig,
      verify_tls: true,
      ca_bundle_path: "/etc/tableau-ai-eval/ca.pem",
    },
    fn,
  );
  // Every outgoing request should carry tls.ca (a BunFile for the bundle) and
  // NOT rejectUnauthorized:false (verify stays on).
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    const tls = (c.init as { tls?: { ca?: unknown; rejectUnauthorized?: boolean } }).tls;
    expect(tls).toBeDefined();
    expect(tls!.ca).toBeDefined();
    expect(tls!.rejectUnauthorized).toBeUndefined();
  }
});

test("serverVersionLabel carries the build", () => {
  // A development server reports version "0.0.0" on every build, so the
  // version alone says nothing: the run record keeps the build beside it.
  expect(serverVersionLabel({ product_version: "0.0.0", product_build: "main.26.0930.1736" })).toBe(
    "0.0.0 (main.26.0930.1736)",
  );
  expect(
    serverVersionLabel({ product_version: "2026.1.0", product_build: "20261.26.0415.1010" }),
  ).toBe("2026.1.0 (20261.26.0415.1010)");
  // Either half alone is still better than nothing; neither is empty.
  expect(serverVersionLabel({ product_version: "2026.1.0" })).toBe("2026.1.0");
  expect(serverVersionLabel({ product_build: "main.26.0930.1736" })).toBe("main.26.0930.1736");
  expect(serverVersionLabel({})).toBe("");
});

test("probeServerinfo reads the build", async () => {
  const { fn } = router([
    [
      "serverinfo",
      () =>
        json({
          serverInfo: {
            productVersion: { value: "0.0.0", build: "main.26.0930.1736" },
            restApiVersion: "3.31",
          },
        }),
    ],
  ]);
  const s = await probeServerinfo("https://tab.example.com", "3.22", { verify: true }, fn);
  expect(s.ok).toBe(true);
  expect(s.product_build).toBe("main.26.0930.1736");
  expect(serverVersionLabel(s)).toBe("0.0.0 (main.26.0930.1736)");
});
