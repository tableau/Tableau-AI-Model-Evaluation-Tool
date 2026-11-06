import { test, expect } from "bun:test";
import { sessionFromRunConfig, connectionKey } from "./session_config.ts";

/** Mock fetch returning canned Responses in sequence, recording calls. */
function mockFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function signinOk(): Response {
  return new Response(
    JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const FULL = {
  tableau_server: "https://tab.example.com",
  tableau_pat_name: "pat",
  tableau_pat_value: "secret",
  tableau_site: "MySite",
};

test("returns null when the PAT triplet is incomplete", () => {
  expect(sessionFromRunConfig({})).toBeNull();
  expect(sessionFromRunConfig({ tableau_server: "https://x" })).toBeNull();
  expect(
    sessionFromRunConfig({ tableau_server: "https://x", tableau_pat_name: "n" }),
  ).toBeNull();
});

test("builds a session from the primary config keys", () => {
  const s = sessionFromRunConfig(FULL);
  expect(s).not.toBeNull();
  expect(s!.serverUrl).toBe("https://tab.example.com");
});

test("accepts the pat_name/pat_value aliases", () => {
  const s = sessionFromRunConfig({
    tableau_server: "https://x",
    pat_name: "n",
    pat_value: "v",
  });
  expect(s).not.toBeNull();
});

test("verify=false disables TLS verification on signin", async () => {
  const { fn, calls } = mockFetch(() => signinOk());
  const s = sessionFromRunConfig({ ...FULL, verify_tls: false }, { fetchImpl: fn })!;
  await s.getToken();
  const tls = (calls[0]!.init as { tls?: { rejectUnauthorized?: boolean } }).tls;
  expect(tls!.rejectUnauthorized).toBe(false);
});

test("verify option overrides config.verify_tls", async () => {
  const { fn, calls } = mockFetch(() => signinOk());
  // config says verify_tls:true, but the explicit override forces false (cabu's
  // verifyTls path).
  const s = sessionFromRunConfig(
    { ...FULL, verify_tls: true },
    { fetchImpl: fn, verify: false },
  )!;
  await s.getToken();
  const tls = (calls[0]!.init as { tls?: { rejectUnauthorized?: boolean } }).tls;
  expect(tls!.rejectUnauthorized).toBe(false);
});

test("caBundleFallback uses config.ca_bundle_path when present (no fallback)", async () => {
  const { fn, calls } = mockFetch(() => signinOk());
  const s = sessionFromRunConfig(
    { ...FULL, verify_tls: true, ca_bundle_path: "/tmp/tableau-ai-eval-ca.pem" },
    { fetchImpl: fn, caBundleFallback: true },
  )!;
  await s.getToken();
  const tls = (calls[0]!.init as { tls?: { ca?: unknown } }).tls;
  expect(tls!.ca).toBeTruthy();
});

test("no caBundleFallback + no config bundle => system trust (no tls) when verify=true", async () => {
  const { fn, calls } = mockFetch(() => signinOk());
  const s = sessionFromRunConfig({ ...FULL, verify_tls: true }, { fetchImpl: fn })!;
  await s.getToken();
  expect((calls[0]!.init as { tls?: unknown }).tls).toBeUndefined();
});

test("connectionKey: default shape is server|site|patName|verify", () => {
  const key = connectionKey(FULL);
  expect(key).toBe("https://tab.example.com|MySite|pat|true");
});

test("connectionKey: leading keys are prepended (prep keys on gateway_url)", () => {
  const key = connectionKey({ ...FULL, gateway_url: "https://gw" }, ["gateway_url"]);
  expect(key).toBe("https://gw|https://tab.example.com|MySite|pat|true");
});

test("connectionKey: never includes the secret; uses pat_name alias", () => {
  const key = connectionKey({
    tableau_server: "https://x",
    pat_name: "n",
    pat_value: "SECRET",
    verify_tls: false,
  });
  expect(key).toContain("n");
  expect(key).not.toContain("SECRET");
  expect(key.endsWith("|false")).toBe(true);
});
