import { test, expect } from "bun:test";
import {
  TableauSession,
  TableauAuthError,
  shareSession,
  sharedSession,
  unshareSession,
} from "./session.ts";

/** Build a mock fetch returning canned Responses in sequence, recording calls. */
function mockFetch(
  responders: Array<(url: string, init: RequestInit) => Response>,
): { fn: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder!(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function signinOk(token: string, siteId: string | null): Response {
  const body = {
    credentials: {
      token,
      site: siteId === null ? {} : { id: siteId },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("successful signin parses token + site LUID", async () => {
  const { fn, calls } = mockFetch([() => signinOk("tok-123", "site-luid-abc")]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com/",
    patName: "pat",
    patSecret: "secret",
    siteContentUrl: "MySite",
    fetchImpl: fn,
  });

  const token = await s.getToken();
  expect(token).toBe("tok-123");
  expect(await s.siteId()).toBe("site-luid-abc");

  // URL is built from trimmed server + default api version 3.22.
  expect(calls[0]!.url).toBe("https://tab.example.com/api/3.22/auth/signin");
  // Request body carries the PAT credentials in the documented shape.
  const body = JSON.parse(calls[0]!.init.body as string);
  expect(body).toEqual({
    credentials: {
      personalAccessTokenName: "pat",
      personalAccessTokenSecret: "secret",
      site: { contentUrl: "MySite" },
    },
  });
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers["Content-Type"]).toBe("application/json");
  expect(headers["Accept"]).toBe("application/json");

  // Cached: a second getToken does not hit the network again.
  expect(await s.getToken()).toBe("tok-123");
  expect(calls.length).toBe(1);
});

test("auth_headers shape is { X-Tableau-Auth: token }", async () => {
  const { fn } = mockFetch([() => signinOk("tok-xyz", "s1")]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });
  expect(await s.authHeaders()).toEqual({ "X-Tableau-Auth": "tok-xyz" });
});

test("proactive refresh after 15 min threshold re-signs in", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const { fn, calls } = mockFetch([
    () => signinOk("tok-first", "s1"),
    () => signinOk("tok-second", "s1"),
  ]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
    clock,
  });

  expect(await s.getToken()).toBe("tok-first");
  expect(calls.length).toBe(1);

  // Just under 15 min: still cached.
  now += 15 * 60 * 1000 - 1;
  expect(await s.getToken()).toBe("tok-first");
  expect(calls.length).toBe(1);

  // At/after threshold: proactive re-signin.
  now += 2;
  expect(await s.getToken()).toBe("tok-second");
  expect(calls.length).toBe(2);
});

test("handle401 invalidates + re-signs in once", async () => {
  const { fn, calls } = mockFetch([
    () => signinOk("tok-A", "s1"),
    () => signinOk("tok-B", "s1"),
  ]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });

  expect(await s.getToken()).toBe("tok-A");
  // Simulate a 401 on a downstream call: caller invokes handle401.
  const fresh = await s.handle401();
  expect(fresh).toBe("tok-B");
  expect(calls.length).toBe(2);
});

test("handle401 re-signs in once per lost session for concurrent 401s", async () => {
  // Several requests in flight all see the same 401 (they carried tok-A). A
  // PAT allows one live session, so only the FIRST re-signs in; the others,
  // whose failed token no longer matches the cached one, reuse the new token.
  const { fn, calls } = mockFetch([
    () => signinOk("tok-A", "s1"),
    () => signinOk("tok-B", "s1"),
  ]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });

  expect(await s.getToken()).toBe("tok-A");
  expect(await s.handle401("tok-A")).toBe("tok-B"); // first request re-signs in
  expect(await s.handle401("tok-A")).toBe("tok-B"); // second reuses it
  expect(await s.handle401("tok-A")).toBe("tok-B"); // third too
  expect(calls.length).toBe(2); // exactly one re-sign-in
});

test("handle401 with the current token really does sign in again", async () => {
  const { fn, calls } = mockFetch([
    () => signinOk("tok-A", "s1"),
    () => signinOk("tok-B", "s1"),
    () => signinOk("tok-C", "s1"),
  ]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });

  expect(await s.getToken()).toBe("tok-A");
  expect(await s.handle401("tok-A")).toBe("tok-B");
  expect(await s.handle401("tok-B")).toBe("tok-C"); // tok-B is dead too
  expect(calls.length).toBe(3);
});

test("handle401 without a known failed token always re-signs in", async () => {
  const { fn, calls } = mockFetch([
    () => signinOk("tok-A", "s1"),
    () => signinOk("tok-B", "s1"),
  ]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });

  expect(await s.getToken()).toBe("tok-A");
  expect(await s.handle401()).toBe("tok-B");
  expect(calls.length).toBe(2);
});

test("signin 401 throws TableauAuthError and fires onAuthFailure", async () => {
  const reasons: string[] = [];
  const { fn } = mockFetch([
    () => new Response("nope", { status: 401 }),
  ]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "bad",
    fetchImpl: fn,
    onAuthFailure: (r) => reasons.push(r),
  });

  await expect(s.getToken()).rejects.toBeInstanceOf(TableauAuthError);
  expect(reasons.length).toBe(1);
  expect(reasons[0]).toContain("401");
});

test("signin 403 throws TableauAuthError and fires onAuthFailure", async () => {
  const reasons: string[] = [];
  const { fn } = mockFetch([() => new Response("forbidden", { status: 403 })]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "bad",
    fetchImpl: fn,
    onAuthFailure: (r) => reasons.push(r),
  });

  await expect(s.getToken()).rejects.toBeInstanceOf(TableauAuthError);
  expect(reasons.length).toBe(1);
  expect(reasons[0]).toContain("403");
});

test("non-2xx/4xx signin raises a generic error (not TableauAuthError)", async () => {
  const { fn } = mockFetch([() => new Response("boom", { status: 500 })]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });
  await expect(s.getToken()).rejects.not.toBeInstanceOf(TableauAuthError);
  await expect(s.getToken()).rejects.toThrow(/answered the sign-in with HTTP 500/);
});

test("unexpected response shape raises a shape error", async () => {
  const { fn } = mockFetch([
    () =>
      new Response(JSON.stringify({ credentials: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ]);
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });
  await expect(s.getToken()).rejects.toThrow(/sign-in answer was not in the expected form/);
});

test("network error is wrapped with the target url", async () => {
  const fn = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });
  await expect(s.getToken()).rejects.toThrow(/Could not reach Tableau Server at .* to sign in/);
});

test("concurrent getToken calls coalesce to a single signin", async () => {
  let resolveFetch: (r: Response) => void;
  const gate = new Promise<Response>((res) => {
    resolveFetch = res;
  });
  let callCount = 0;
  const fn = (async () => {
    callCount += 1;
    return gate;
  }) as unknown as typeof fetch;
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
    fetchImpl: fn,
  });

  const p1 = s.getToken();
  const p2 = s.getToken();
  resolveFetch!(signinOk("shared", "s1"));
  const [t1, t2] = await Promise.all([p1, p2]);
  expect(t1).toBe("shared");
  expect(t2).toBe("shared");
  expect(callCount).toBe(1);
});

test("shared-session registry: share/shared/unshare keyed by jobId", () => {
  const s = new TableauSession({
    serverUrl: "https://tab.example.com",
    patName: "p",
    patSecret: "x",
  });
  expect(sharedSession("job-share")).toBeNull();
  expect(sharedSession(null)).toBeNull();
  expect(sharedSession(undefined)).toBeNull();
  shareSession("job-share", s);
  expect(sharedSession("job-share")).toBe(s);
  // A different job never sees another run's session.
  expect(sharedSession("other-job")).toBeNull();
  unshareSession("job-share");
  expect(sharedSession("job-share")).toBeNull();
});

test("conversation leases defer proactive refresh but allow coalesced 401 recovery", async () => {
  let now = 0;
  let signins = 0;
  const s = new TableauSession({ serverUrl: "https://tab.example.com", patName: "p", patSecret: "x",
    clock: () => now, fetchImpl: (async () => signinOk(`t${++signins}`, "site")) as unknown as typeof fetch });
  const first = await s.acquireConversationToken();
  now = 16 * 60 * 1000;
  const second = await s.acquireConversationToken();
  expect(second.token).toBe(first.token);
  expect(signins).toBe(1);
  expect(await Promise.all([s.handle401(first.token), s.handle401(second.token)])).toEqual(["t2", "t2"]);
  expect(signins).toBe(2);
  now += 16 * 60 * 1000;
  first.release();
  first.release(); // idempotent
  expect(await s.getToken()).toBe("t2");
  second.release();
  expect(await s.getToken()).toBe("t3");
});

test("a failed conversation acquisition does not retain a refresh hold", async () => {
  let now = 0;
  let signins = 0;
  const s = new TableauSession({ serverUrl: "https://tab.example.com", patName: "p", patSecret: "x",
    clock: () => now, fetchImpl: (async () => ++signins === 1
      ? new Response("bad", { status: 401 }) : signinOk(`t${signins}`, "site")) as unknown as typeof fetch });
  await expect(s.acquireConversationToken()).rejects.toThrow(TableauAuthError);
  const lease = await s.acquireConversationToken();
  lease.release();
  now = 16 * 60 * 1000;
  expect(await s.getToken()).toBe("t3");
});

test("overlapping expired-token acquisitions both wait for the proactive refresh", async () => {
  let now = 0;
  let signins = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = new TableauSession({ serverUrl: "https://tab.example.com", patName: "p", patSecret: "x",
    clock: () => now, fetchImpl: (async () => {
      if (++signins === 2) await gate;
      return signinOk(`t${signins}`, "site");
    }) as unknown as typeof fetch });
  await s.getToken();
  now = 16 * 60 * 1000;
  const first = s.acquireConversationToken();
  const second = s.acquireConversationToken();
  release();
  const leases = await Promise.all([first, second]);
  expect(leases.map(lease => lease.token)).toEqual(["t2", "t2"]);
  expect(signins).toBe(2);
  for (const lease of leases) lease.release();
});
