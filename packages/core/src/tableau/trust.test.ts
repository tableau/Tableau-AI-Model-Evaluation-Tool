import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";
import {
  derToPem,
  certComment,
  resolveOutPath,
  parseHostPort,
  extractPemBlocks,
} from "./trust.ts";

test("derToPem frames base64 DER as a PEM CERTIFICATE block wrapped at 64 cols", () => {
  const der = new Uint8Array(100).fill(0x41); // 100 'A' bytes
  const pem = derToPem(der);
  expect(pem.startsWith("-----BEGIN CERTIFICATE-----\n")).toBe(true);
  expect(pem.trimEnd().endsWith("-----END CERTIFICATE-----")).toBe(true);
  const body = pem
    .replace("-----BEGIN CERTIFICATE-----\n", "")
    .replace("\n-----END CERTIFICATE-----\n", "");
  // Round-trips back to the original bytes.
  expect(Buffer.from(body.replace(/\n/g, ""), "base64")).toEqual(Buffer.from(der));
  // No base64 line exceeds 64 chars.
  for (const line of body.split("\n")) expect(line.length).toBeLessThanOrEqual(64);
});

// Expectations go through path.resolve/join so they hold on POSIX and Windows
// (where "/home/me" resolves to "C:\home\me").
test("resolveOutPath: --out wins (with ~ expansion)", () => {
  expect(resolveOutPath("~/certs/x.pem", "/home/me")).toBe(resolve("/home/me/certs/x.pem"));
  expect(resolveOutPath("/abs/out.pem", "/home/me")).toBe(resolve("/abs/out.pem"));
});

test("resolveOutPath: defaults to ~/.tableau-ai-eval/ca.pem", () => {
  expect(resolveOutPath(undefined, "/home/me")).toBe(join("/home/me", ".tableau-ai-eval", "ca.pem"));
  expect(resolveOutPath("  ", "/home/me")).toBe(join("/home/me", ".tableau-ai-eval", "ca.pem"));
});

test("parseHostPort: host, host:port, and full URLs", () => {
  expect(parseHostPort("tab.example.com")).toEqual({
    hostname: "tab.example.com",
    port: 443,
  });
  expect(parseHostPort("tab.example.com:8443")).toEqual({
    hostname: "tab.example.com",
    port: 8443,
  });
  expect(parseHostPort("https://tab.example.com/path")).toEqual({
    hostname: "tab.example.com",
    port: 443,
  });
  expect(parseHostPort("https://tab.example.com:9000/x")).toEqual({
    hostname: "tab.example.com",
    port: 9000,
  });
  expect(parseHostPort("http://tab.example.com")).toEqual({
    hostname: "tab.example.com",
    port: 80,
  });
});

test("extractPemBlocks pulls every CERTIFICATE block from openssl-style output", () => {
  const text =
    "noise\n" +
    "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" +
    "junk in between\n" +
    "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n" +
    "trailer";
  const blocks = extractPemBlocks(text);
  expect(blocks.length).toBe(2);
  expect(blocks[0]).toContain("AAAA");
  expect(blocks[1]).toContain("BBBB");
  expect(extractPemBlocks("nothing here")).toEqual([]);
});

// --- curl-style comment header --------------------------------------------

/** Generate a throwaway self-signed cert (PEM) for comment tests, or null if
 * openssl is unavailable (CI images without it just skip these assertions). */
function selfSignedPem(): string | null {
  try {
    return execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        "/dev/null",
        "-subj",
        "/CN=AI Eval Test Root/O=AI Eval/OU=Test CA",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
}

test("certComment emits curl-style Issuer/Subject/Label/Serial/fingerprint lines", () => {
  const pem = selfSignedPem();
  if (!pem) return; // openssl not present; skip.
  const der = new X509Certificate(pem).raw;
  const c = certComment(der);
  expect(c).toContain("# Issuer: CN=AI Eval Test Root O=AI Eval OU=Test CA");
  expect(c).toContain("# Subject: CN=AI Eval Test Root O=AI Eval OU=Test CA");
  expect(c).toContain('# Label: "AI Eval Test Root"');
  expect(c).toMatch(/# Serial: [0-9A-Fa-f]+\n/);
  expect(c).toMatch(/# SHA1 Fingerprint: (?:[0-9A-F]{2}:)+[0-9A-F]{2}\n/);
  expect(c).toMatch(/# SHA256 Fingerprint: (?:[0-9A-F]{2}:)+[0-9A-F]{2}\n/);
  // MD5 is intentionally omitted.
  expect(c).not.toContain("MD5");
  // Comment lines come before the (separately emitted) PEM block.
  expect(c.trimEnd().split("\n").every((l) => l.startsWith("# "))).toBe(true);
});

test("certComment returns '' for non-DER input (best-effort)", () => {
  expect(certComment(Buffer.from("not a cert"))).toBe("");
});

test("extractPemBlocks prepends a comment header when the block is real DER", () => {
  const pem = selfSignedPem();
  if (!pem) return; // openssl not present; skip.
  const [block] = extractPemBlocks(pem);
  expect(block).toContain("# Subject: CN=AI Eval Test Root");
  // The original PEM frame is preserved after the comment.
  expect(block).toContain("-----BEGIN CERTIFICATE-----");
  expect(block.indexOf("# Subject")).toBeLessThan(
    block.indexOf("-----BEGIN CERTIFICATE-----"),
  );
});
