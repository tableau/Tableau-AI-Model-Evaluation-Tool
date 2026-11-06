import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ADAPTER_ID,
  getAdapter,
  register,
  type EvalAdapter,
} from "./contract.ts";

function fakeAdapter(id: string): EvalAdapter {
  return {
    id,
    session: () => ({ close() {} }),
    load: () => ({ total: 0, skeletons: [], conversation_ids: [] }),
    execute: async () => {},
  };
}

/**
 * NOTE: the registry is process-global and adapters self-register on import,
 * Once a lazy module is imported it stays
 * registered (import is cached in both languages). Tests therefore do NOT clear
 * the registry between cases — clearing it would defeat the "import once,
 * registered forever" semantics the port faithfully reproduces.
 *
 * The concrete adapters (nlq/prep/cabu) live in `@tableau-ai-eval/evals`; core no longer
 * knows how to load them (no package cycle). Their resolution is covered in
 * `@tableau-ai-eval/evals`' register.test.ts, which calls `registerAdapters()` first.
 * These tests stay purely on the core registry contract.
 */
describe("adapter registry", () => {
  test("default id is nlq", () => {
    expect(DEFAULT_ADAPTER_ID).toBe("nlq");
  });

  test("resolves an explicitly registered adapter by id", async () => {
    const a = fakeAdapter("__test_explicit__");
    register(a);
    const resolved = await getAdapter({ adapter: "__test_explicit__" });
    expect(resolved).toBe(a);
  });

  test("throws a descriptive error for an unknown id", async () => {
    await expect(getAdapter({ adapter: "nope-unregistered" })).rejects.toThrow(
      /Unknown eval adapter "nope-unregistered"/,
    );
  });

  test("unknown-id error lists registered adapters sorted", async () => {
    register(fakeAdapter("zeta_reg"));
    register(fakeAdapter("alpha_reg"));
    let msg = "";
    try {
      await getAdapter({ adapter: "still-missing" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Registered ids are listed sorted; alpha_reg precedes zeta_reg.
    expect(msg).toMatch(/registered: \[/);
    expect(msg.indexOf('"alpha_reg"')).toBeLessThan(msg.indexOf('"zeta_reg"'));
  });
});
