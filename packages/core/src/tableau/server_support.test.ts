import { expect, test } from "bun:test";
import { configuredMinRelease, parseRelease, releaseBeforeMinimum, tooOldMessage } from "./server_support.ts";

test("minimum release override accepts only a release label", () => {
  expect(configuredMinRelease("2026.3")).toEqual([2026, 3]);
  expect(configuredMinRelease("invalid")).toEqual([2026, 3]);
  expect(configuredMinRelease("2026.2.1")).toEqual([2026, 3]);
});

// Server release checks.

test("parseRelease reads year and minor only", () => {
  expect(parseRelease("2025.3.2")).toEqual([2025, 3]);
  expect(parseRelease("2026.3.0")).toEqual([2026, 3]);
  expect(parseRelease("2026.10")).toEqual([2026, 10]);
  expect(parseRelease("0.0.0")).toBeNull(); // development build
  expect(parseRelease("")).toBeNull();
  expect(parseRelease(null)).toBeNull();
  expect(parseRelease("main.26.0930")).toBeNull();
});

test("releaseBeforeMinimum is tri-state", () => {
  expect(releaseBeforeMinimum("2025.3.2")).toBe(true);
  expect(releaseBeforeMinimum("2026.2.0")).toBe(true);
  expect(releaseBeforeMinimum("2026.3.0")).toBe(false);
  expect(releaseBeforeMinimum("2027.1.0")).toBe(false);
  expect(releaseBeforeMinimum("0.0.0")).toBeNull();
});

test("tooOldMessage names the release and the remedy", () => {
  const msg = tooOldMessage("2025.3.1");
  expect(msg.startsWith("Tableau Server 2025.3 is earlier than 2026.3")).toBe(true);
  expect(msg).toContain("test suites are disabled");
  expect(msg).toContain("Upgrade the server to 2026.3 or later");
  expect(msg).toContain("published");
  // No version known (a 404 was the only evidence)
  expect(tooOldMessage(null).startsWith("This Tableau Server is earlier than 2026.3")).toBe(true);
});
