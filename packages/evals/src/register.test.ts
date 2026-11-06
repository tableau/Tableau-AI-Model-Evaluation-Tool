import { describe, expect, test, beforeAll } from "bun:test";
import { getAdapter } from "@tableau-ai-eval/core";
import { registerAdapters } from "./index.ts";

/**
 * The concrete adapters (nlq / prep / cabu) live in `@tableau-ai-eval/evals`.
 * `@tableau-ai-eval/core`'s registry no longer knows how to load them (that would be a
 * package cycle); instead the server calls `registerAdapters()` at startup.
 *
 * These cases (moved out of core's contract.test.ts) verify that once
 * `registerAdapters()` has run, `getAdapter` resolves each concrete id — the
 * server↔evals registration seam.
 */
describe("evals adapter registration", () => {
  beforeAll(async () => {
    await registerAdapters();
  });

  test("registerAdapters is idempotent", async () => {
    await registerAdapters();
    await registerAdapters();
  });

  test("defaults to nlq when no adapter key is given", async () => {
    const resolved = await getAdapter({});
    expect(resolved.id).toBe("nlq");
  });

  test("defaults to nlq when adapter is empty/falsey", async () => {
    const resolved = await getAdapter({ adapter: "" });
    expect(resolved.id).toBe("nlq");
  });

  test("resolves each registered concrete id", async () => {
    for (const id of ["nlq", "prep_server", "cabu", "palettes"]) {
      const resolved = await getAdapter({ adapter: id });
      expect(resolved.id).toBe(id);
    }
  });
});
