import { expect, test } from "bun:test";
import { NarrativeScoringPool } from "./narrative_pool.ts";
import { computeNarrativeMetrics } from "./narrative.ts";
import goldens from "../../../../goldens/narrative/expected.json";

test("bounded workers keep concurrent cases isolated and preserve metric order", async () => {
  const pool = new NarrativeScoringPool(2);
  const rows = goldens.rows.slice(0, 3);
  try {
    const results = await Promise.all(
      rows.map((row) => pool.compute(row.views, row.expected, row.actual)),
    );
    for (const [index, row] of rows.entries()) {
      expect(results[index]).toEqual(computeNarrativeMetrics(row.views, row.expected, row.actual));
    }
  } finally {
    pool.close();
  }
});

test("an expensive score does not prevent main-thread timers from running", async () => {
  const pool = new NarrativeScoringPool(2);
  const row = goldens.rows.find((row) => row.case.includes("NHS_Hospital"))!;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const result = await pool.compute(row.views, row.expected, row.actual);
    expect(result).toHaveLength(5);
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(timer);
    pool.close();
  }
}, 30000);

test("closing a pool rejects active and queued scores, and future work", async () => {
  const pool = new NarrativeScoringPool(1);
  const pending = pool.compute([], "Reference", "Summary");
  const rejected = pending.catch((error) => error as Error);
  pool.close();
  expect(await rejected).toBeInstanceOf(Error);
  expect(((await rejected) as Error).message).toContain("closed");
  await expect(pool.compute([], null, "Summary")).rejects.toThrow("closed");
  expect(() => new NarrativeScoringPool(0)).toThrow("positive integer");
});

test("worker startup failure rejects scoring rather than blocking the queue", async () => {
  const pool = new NarrativeScoringPool(1, new URL("./missing_worker.ts", import.meta.url));
  try {
    await expect(pool.compute([], null, "Summary")).rejects.toThrow();
  } finally {
    pool.close();
  }
});

test("worker scoring errors reject the case but workers remain usable", async () => {
  const pool = new NarrativeScoringPool(1);
  try {
    // Structured cloning supports cycles, but a cyclic summary is invalid.
    // Its traversal fails inside the worker, not in the transport.
    const summary: Record<string, unknown> = {};
    summary.sections = summary;
    await expect(pool.compute([], null, summary)).rejects.toThrow();
    expect(await pool.compute([], null, "Summary")).toHaveLength(5);
  } finally {
    pool.close();
  }
});
