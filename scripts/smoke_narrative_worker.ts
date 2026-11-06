/** Compiled-worker smoke: runs offline, even with no source checkout on disk. */
import { NarrativeScoringPool } from "../packages/evals/src/metrics/narrative_pool.ts";

if (import.meta.main) {
  const pool = new NarrativeScoringPool(2);
  try {
    const metrics = await pool.compute([], null, "Sales increased.");
    if (metrics.length !== 5 || metrics.some((metric) => metric.score !== 1)) {
      throw new Error("Unexpected narrative worker scores");
    }
    console.log("Narrative worker smoke passed");
  } finally {
    pool.close();
  }
}
