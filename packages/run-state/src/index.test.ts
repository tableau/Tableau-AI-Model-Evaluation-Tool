import { expect, test } from "bun:test";
import { applyRunChange, type RunProjection } from "./index.ts";

const initial: RunProjection = { jobId: "r", revision: 0, executionId: "e",
  run: { job_id: "r", status: "started", total: 2, completed: 0, config: {} },
  state: {}, cases: [], results: {}, runningIds: ["a"], retryingIds: [] };

test("pause is an indivisible transition and duplicates cannot roll state backward", () => {
  const event = { type: "change" as const, jobId: "r", revision: 1, executionId: "revoked",
    run: { status: "paused" as const } };
  const paused = applyRunChange(initial, event);
  expect(paused.runningIds).toEqual([]);
  expect(paused.state.running_case_ids).toEqual([]);
  expect(paused.run.status).toBe("paused");
  expect(applyRunChange(paused, event)).toBe(paused);
  expect(() => applyRunChange(initial, { ...event, revision: 2 })).toThrow("revision gap");
  expect(() => applyRunChange(initial, { ...event, jobId: "another" })).toThrow("identity mismatch");
});
