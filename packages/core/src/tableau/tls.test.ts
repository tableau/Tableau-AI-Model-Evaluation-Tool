import { test, expect } from "bun:test";
import { join } from "node:path";
import { tlsOptions, tlsInit, resolveCaBundlePath } from "./tls.ts";

// A sentinel "opened file" so tests never need a real PEM on disk.
const FAKE_FILE = { __fake: "bunfile" };
const openFake = (path: string) => ({ ...FAKE_FILE, path });

test("tlsOptions: verify=false => rejectUnauthorized:false (CA ignored)", () => {
  const t = tlsOptions({ verify: false, caBundlePath: "/x/ca.pem", openFile: openFake });
  expect(t).toEqual({ rejectUnauthorized: false });
});

test("tlsOptions: verify=true + caBundlePath => { ca } (verify stays on)", () => {
  const t = tlsOptions({ verify: true, caBundlePath: "/x/ca.pem", openFile: openFake });
  expect(t.rejectUnauthorized).toBeUndefined();
  expect(t.ca).toEqual({ ...FAKE_FILE, path: "/x/ca.pem" });
});

test("tlsOptions: verify=true, blank caBundlePath => {} (default system trust)", () => {
  expect(tlsOptions({ verify: true, openFile: openFake })).toEqual({});
  expect(tlsOptions({ verify: true, caBundlePath: "   ", openFile: openFake })).toEqual({});
});

test("tlsInit wraps into a RequestInit fragment (and omits empty tls)", () => {
  expect(tlsInit({ verify: true })).toEqual({});
  expect(tlsInit({ verify: false })).toEqual({ tls: { rejectUnauthorized: false } });
  const withCa = tlsInit({ verify: true, caBundlePath: "/x/ca.pem", openFile: openFake });
  expect(withCa.tls).toBeDefined();
  expect(withCa.tls!.ca).toEqual({ ...FAKE_FILE, path: "/x/ca.pem" });
});

test("resolveCaBundlePath: explicit TABLEAU_AI_EVAL_CA_BUNDLE wins (with ~ expansion)", () => {
  const p = resolveCaBundlePath(
    { TABLEAU_AI_EVAL_CA_BUNDLE: "~/certs/ca.pem" } as NodeJS.ProcessEnv,
    "/home/me",
    () => false,
  );
  expect(p).toBe("/home/me/certs/ca.pem");
});

test("resolveCaBundlePath: auto-detects ~/.tableau-ai-eval/ca.pem when it exists", () => {
  // Built with path.join so the expectation uses the platform separator.
  const expected = join("/home/me", ".tableau-ai-eval", "ca.pem");
  const p = resolveCaBundlePath({} as NodeJS.ProcessEnv, "/home/me", (path) => path === expected);
  expect(p).toBe(expected);
});

test("resolveCaBundlePath: undefined when neither env nor auto-detect present", () => {
  const p = resolveCaBundlePath({} as NodeJS.ProcessEnv, "/home/me", () => false);
  expect(p).toBeUndefined();
});
