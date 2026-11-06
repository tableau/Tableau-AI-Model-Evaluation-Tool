/**
 * Unit tests for the pure platform → hyperdb-api-node tag/package/filename
 * resolvers in platform.ts. These functions take explicit (platform, arch)
 * args, so the tests are host-independent. The module-system / filesystem
 * touching helpers (resolveNativeNodePath) are
 * deliberately NOT tested here — only the pure functions.
 */

import { describe, expect, it } from "bun:test";
import {
  hyperdBinaryName,
  nativeNodeFileName,
  platformPackage,
  platformTag,
} from "./platform.ts";

describe("platformTag (deterministic cases)", () => {
  const cases: Array<[NodeJS.Platform, string, string | null]> = [
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", null], // No pinned Hyper npm package for this target
    ["win32", "x64", "win32-x64-msvc"],
    ["win32", "ia32", null], // unsupported win arch
    ["freebsd" as NodeJS.Platform, "x64", null], // unsupported platform
  ];
  for (const [platform, arch, want] of cases) {
    it(`${platform}/${arch} -> ${want}`, () => {
      expect(platformTag(platform, arch)).toBe(want);
    });
  }
});

describe("platformTag (linux — libc suffix is host-dependent)", () => {
  // isMusl() inspects the host, so assert only the arch-stable prefix rather
  // than the exact gnu/musl suffix to avoid host-musl flakiness.
  it("linux/x64 -> linux-x64-<libc>", () => {
    const tag = platformTag("linux", "x64") ?? "";
    expect(tag.startsWith("linux-x64-")).toBe(true);
  });
  it("linux/arm64 -> linux-arm64-<libc>", () => {
    const tag = platformTag("linux", "arm64") ?? "";
    expect(tag.startsWith("linux-arm64-")).toBe(true);
  });
});

describe("platformPackage", () => {
  it("prefixes the tag with hyperdb-api-node-", () => {
    expect(platformPackage("darwin-arm64")).toBe("hyperdb-api-node-darwin-arm64");
  });
});

describe("nativeNodeFileName", () => {
  it("builds hyperdb-api-node.<tag>.node", () => {
    expect(nativeNodeFileName("darwin-arm64")).toBe(
      "hyperdb-api-node.darwin-arm64.node",
    );
  });
});

describe("hyperdBinaryName", () => {
  it("win32 -> hyperd.exe", () => {
    expect(hyperdBinaryName("win32")).toBe("hyperd.exe");
  });
  it("darwin -> hyperd", () => {
    expect(hyperdBinaryName("darwin")).toBe("hyperd");
  });
  it("linux -> hyperd", () => {
    expect(hyperdBinaryName("linux")).toBe("hyperd");
  });
});
