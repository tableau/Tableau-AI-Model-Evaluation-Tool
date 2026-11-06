import { test, expect } from "bun:test";
import { CesBridge, flattenMessages, wrapChatResponse, RetryableCesError, type CesResponse, type EgptChatResponse } from "./ces.ts";
import { TableauSession } from "@tableau-ai-eval/core";

/** A capturing fetch that returns canned responses in sequence. */
function captureFetch(
  responders: Array<(url: string, init: RequestInit) => Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = responders[Math.min(i, responders.length - 1)]!;
    i += 1;
    return r(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function cesReply(text: string, promptTokens = 3, completionTokens = 4): Response {
  return new Response(
    JSON.stringify({
      generations: [{ text, parameters: { finish_reason: "stop" } }],
      parameters: { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** A session whose signin is mocked (so authHeaders yields X-Tableau-Auth). */
function fakeSession(token: string, fetchImpl?: typeof fetch): TableauSession {
  const fn =
    fetchImpl ??
    ((async () =>
      new Response(JSON.stringify({ credentials: { token, site: { id: "site-1" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch);
  return new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "pat",
    patSecret: "secret",
    fetchImpl: fn,
  });
}

// -- pure helpers ------------------------------------------------------------

test("flattenMessages: system parts first, then non-system, joined by blank lines", () => {
  const out = flattenMessages([
    { role: "user", content: "Q" },
    { role: "system", content: "S1" },
    { role: "assistant", content: "A" },
    { role: "system", content: "S2" },
    { role: "user", content: "" }, // empty dropped
  ]);
  expect(out).toBe("S1\n\nS2\n\nQ\n\nA");
});

test("wrapChatResponse reshapes CES prompt reply into EGPT chat shape", () => {
  const out = wrapChatResponse(
    {
      generations: [{ text: "hi", parameters: { finish_reason: "length" } }],
      parameters: { usage: { prompt_tokens: 2, completion_tokens: 8 } },
    },
    "some-model",
  );
  expect(out.generation_details.generations[0]!.content).toBe("hi");
  expect(out.generation_details.generations[0]!.parameters.finish_reason).toBe("length");
  expect(out.generation_details.parameters.model).toBe("some-model");
  expect(out.generation_details.parameters.usage).toEqual({
    prompt_tokens: 2,
    completion_tokens: 8,
    total_tokens: 10,
  });
});

// -- forwarding: URL + auth header -------------------------------------------

test("wrapChatResponse defaults absent and null response fields", () => {
  for (const data of [undefined, null, {}, { generations: [null], parameters: { usage: null } }]) {
    const out = wrapChatResponse(data, "m");
    expect(out.generation_details.generations[0]).toEqual({
      content: "", role: "assistant", parameters: { finish_reason: "stop" },
    });
    expect(out.generation_details.parameters.usage).toEqual({
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    });
  }
});

test("forward builds the CES generations URL and sends X-Tableau-Auth", async () => {
  const { fn, calls } = captureFetch([() => cesReply("answer")]);
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com/",
    session: fakeSession("TOK-123"),
    fetchImpl: fn,
  });

  const data = await bridge.forward("the prompt", "the-model", 0.5);
  expect(data.generations?.[0]?.text).toBe("answer");

  expect(bridge.cesUrl).toBe("https://ces.example.com/analytics-assistant/v1/generations");
  expect(calls[0]!.url).toBe("https://ces.example.com/analytics-assistant/v1/generations");
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers["X-Tableau-Auth"]).toBe("TOK-123");
  expect(headers["Content-Type"]).toBe("application/json");
  const sent = JSON.parse(calls[0]!.init.body as string);
  expect(sent).toEqual({ prompt: "the prompt", model: "the-model", temperature: 0.5 });
});

test("no session → no X-Tableau-Auth header (local-dev backdoor)", async () => {
  const { fn, calls } = captureFetch([() => cesReply("x")]);
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", fetchImpl: fn });
  await bridge.forward("p", "m", 0);
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers["X-Tableau-Auth"]).toBeUndefined();
});

// -- inbound handler routes --------------------------------------------------

test("handle /v1.0/chat/generations flattens messages and rewraps reply", async () => {
  const { fn, calls } = captureFetch([() => cesReply("chat-answer")]);
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com",
    session: fakeSession("TOK-9"),
    fetchImpl: fn,
  });
  const resp = await bridge.handle(
    new Request("http://127.0.0.1/v1.0/chat/generations", {
      method: "POST",
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
        temperature: 0.2,
      }),
    }),
  );
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as EgptChatResponse;
  expect(body.generation_details.generations[0].content).toBe("chat-answer");
  const sent = JSON.parse(calls[0]!.init.body as string);
  expect(sent.prompt).toBe("S\n\nU");
  expect(sent.temperature).toBe(0.2);
});

test("handle /v1.0/generations is a near-passthrough", async () => {
  const { fn } = captureFetch([() => cesReply("prompt-answer")]);
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", fetchImpl: fn });
  const resp = await bridge.handle(
    new Request("http://127.0.0.1/v1.0/generations", {
      method: "POST",
      body: JSON.stringify({ prompt: "raw", model: "m" }),
    }),
  );
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as CesResponse;
  expect(body.generations?.[0]?.text).toBe("prompt-answer");
});

// -- resilience --------------------------------------------------------------

test("5xx is retried then surfaces RetryableCesError after 3 attempts", async () => {
  const { fn, calls } = captureFetch([
    () => new Response("boom", { status: 500 }),
  ]);
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", fetchImpl: fn });
  let err: unknown;
  try {
    await bridge.forward("p", "m", 0);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RetryableCesError);
  expect(calls.length).toBe(3);
});

test("401 triggers one session re-signin then retry", async () => {
  // Session signin always ok. CES: first 401, then 200.
  let cesCall = 0;
  const cesFetch = (async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    // The session's own signin requests hit the tableau URL; CES hits ces url.
    const url = String(input);
    if (url.includes("/auth/signin")) {
      return new Response(JSON.stringify({ credentials: { token: "TOK", site: { id: "s" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    cesCall += 1;
    if (cesCall === 1) {
      return new Response("unauthorized", { status: 401 });
    }
    return cesReply("recovered");
  }) as unknown as typeof fetch;

  const session = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "pat",
    patSecret: "secret",
    fetchImpl: cesFetch,
  });
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com",
    session,
    fetchImpl: cesFetch,
  });
  const data = await bridge.forward("p", "m", 0);
  expect(data.generations?.[0]?.text).toBe("recovered");
  expect(cesCall).toBe(2);
});

test("401 re-signin passes the failed token; concurrent 401s re-signin once", async () => {
  // A first request carries TOK-1, gets a 401, and re-signs in to TOK-2. A
  // second in-flight request that still holds TOK-1 and hits a 401 must reuse
  // TOK-2 rather than sign in again (a PAT allows one live session).
  let signins = 0;
  const cesFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/signin")) {
      signins += 1;
      return new Response(
        JSON.stringify({ credentials: { token: `TOK-${signins}`, site: { id: "s" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const sent = (init?.headers as Record<string, string>)?.["X-Tableau-Auth"];
    // The first request's initial call carries TOK-1 → 401; the retry (TOK-2) → 200.
    if (sent === "TOK-1") return new Response("unauthorized", { status: 401 });
    return cesReply("ok");
  }) as unknown as typeof fetch;

  const session = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "pat",
    patSecret: "secret",
    fetchImpl: cesFetch,
  });
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com",
    session,
    fetchImpl: cesFetch,
  });
  await bridge.forward("p", "m", 0);
  expect(signins).toBe(2); // initial signin + one re-signin after 401

  // A second caller that still held TOK-1 gets a 401 too: handle401 reuses TOK-2.
  expect(await session.handle401("TOK-1")).toBe("TOK-2");
  expect(signins).toBe(2); // no new sign-in
});

test("handle surfaces TableauAuthError as 401", async () => {
  // Session signin refuses (401) → handle401 throws TableauAuthError.
  const authFail = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/auth/signin")) {
      return new Response("nope", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as unknown as typeof fetch;

  const session = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "pat",
    patSecret: "secret",
    fetchImpl: authFail,
  });
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com",
    session,
    fetchImpl: authFail,
  });
  const resp = await bridge.handle(
    new Request("http://127.0.0.1/v1.0/chat/generations", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "U" }] }),
    }),
  );
  expect(resp.status).toBe(401);
});

test("4xx (non-401) surfaces as a 502 CES failure through the handler", async () => {
  const { fn } = captureFetch([() => new Response("bad request", { status: 400 })]);
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", fetchImpl: fn });
  const resp = await bridge.handle(
    new Request("http://127.0.0.1/v1.0/generations", {
      method: "POST",
      body: JSON.stringify({ prompt: "p", model: "m" }),
    }),
  );
  expect(resp.status).toBe(502);
});

// -- TLS ergonomics (verify / private-CA parity with TableauSession) ---------

test("CES fetch trusts a private CA when verify=true + caBundlePath", async () => {
  const { fn, calls } = captureFetch([() => cesReply("ok")]);
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com",
    fetchImpl: fn,
    verify: true,
    caBundlePath: "/tmp/tableau-ai-eval-ca.pem",
  });
  await bridge.forward("p", "m", 0);
  const tls = (calls[0]!.init as { tls?: { ca?: unknown; rejectUnauthorized?: boolean } }).tls;
  expect(tls).toBeTruthy();
  expect(tls!.ca).toBeTruthy();
  expect(tls!.rejectUnauthorized).toBeUndefined();
});

test("CES fetch disables verification when verify=false", async () => {
  const { fn, calls } = captureFetch([() => cesReply("ok")]);
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com",
    fetchImpl: fn,
    verify: false,
  });
  await bridge.forward("p", "m", 0);
  const tls = (calls[0]!.init as { tls?: { rejectUnauthorized?: boolean } }).tls;
  expect(tls!.rejectUnauthorized).toBe(false);
});

test("CES fetch uses system trust (no tls) when verify=true + no caBundlePath", async () => {
  const { fn, calls } = captureFetch([() => cesReply("ok")]);
  const bridge = new CesBridge({
    cesHost: "https://ces.example.com",
    fetchImpl: fn,
    verify: true,
  });
  await bridge.forward("p", "m", 0);
  expect((calls[0]!.init as { tls?: unknown }).tls).toBeUndefined();
});

// -- per-case error wording -----------------------------------------------

async function promptError(bridge: CesBridge, status: number): Promise<string> {
  const resp = await bridge.handle(
    new Request("http://127.0.0.1/v1.0/generations", {
      method: "POST",
      body: JSON.stringify({ prompt: "p", model: "m" }),
    }),
  );
  expect(resp.status).toBe(status);
  return ((await resp.json()) as { message: string }).message;
}

test("an endpoint 404 is explained as an old release", async () => {
  const { fn } = captureFetch([() => new Response("Not Found", { status: 404 })]);
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", fetchImpl: fn });
  const msg = await promptError(bridge, 502);
  expect(msg).toContain("earlier than 2026.3");
  expect(msg).toContain("Upgrade the server");
  expect(msg).toContain("HTTP 404");
});

test("an endpoint 401 after re-auth is the flag, not the token", async () => {
  let signins = 0;
  const cesFetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/auth/signin")) {
      signins += 1;
      return new Response(JSON.stringify({ credentials: { token: `T${signins}`, site: { id: "s" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unauthorized", { status: 401 });
  }) as unknown as typeof fetch;
  const session = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "pat",
    patSecret: "secret",
    fetchImpl: cesFetch,
  });
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", session, fetchImpl: cesFetch });
  const msg = await promptError(bridge, 502);
  expect(signins).toBe(2); // the first sign-in + one renewal
  expect(msg).toContain("does not enable the AI endpoint");
  expect(msg.toLowerCase()).not.toContain("enable it in settings");
});

test("another 4xx says the server refused and what to check", async () => {
  const { fn } = captureFetch([() => new Response("forbidden", { status: 403 })]);
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", fetchImpl: fn });
  const msg = await promptError(bridge, 502);
  expect(msg).toContain("refused the AI request (HTTP 403: forbidden)");
  expect(msg).toContain("Evaluation Setup, step 1");
});

test("an exhausted 5xx blames the site's model, not the connection", async () => {
  const { fn } = captureFetch([() => new Response("LLM Gateway generations failed", { status: 500 })]);
  const bridge = new CesBridge({ cesHost: "https://ces.example.com", fetchImpl: fn });
  const msg = await promptError(bridge, 502);
  expect(msg).toContain("AI model did not answer");
  expect(msg).toContain("HTTP 500");
  expect(msg).toContain("Site Settings > AI in Tableau");
  expect(msg).toContain("resume the evaluation");
});

test("a network failure after the retries names the address", async () => {
  const fn = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const bridge = new CesBridge({ cesHost: "http://ces.example.com:8080", fetchImpl: fn });
  const msg = await promptError(bridge, 502);
  expect(msg).toContain(
    "did not answer at http://ces.example.com:8080/analytics-assistant/v1/generations",
  );
  expect(msg).toContain("connection refused");
  expect(msg).toContain("VPN");
});
