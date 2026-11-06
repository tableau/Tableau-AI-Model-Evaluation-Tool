/** Offline CPU benchmark: serial scoring, one worker, and parallel metric groups.
 * Run: bun scripts/bench-narrative.ts [repetitions=3]. No model/server requests.
 * For a compiled-worker smoke test, list narrative_worker.ts as an entrypoint.
 */
import { performance } from "node:perf_hooks";
import goldens from "../goldens/narrative/expected.json";
import { computeNarrativeMetrics } from "../packages/evals/src/metrics/narrative.ts";
import { NarrativeScoringPool } from "../packages/evals/src/metrics/narrative_pool.ts";

const repetitions = Number(process.argv[2] || 3);
if (!Number.isInteger(repetitions) || repetitions < 1)
  throw new Error("Repetitions must be a positive integer");

const defaultPool = new NarrativeScoringPool();
const sizes = [...new Set([1, defaultPool.size])];
defaultPool.close();
const workloads = Array.from({ length: repetitions }, () => goldens.rows).flat();
const elapsed = (start: number) => Math.round(performance.now() - start);

const serialStart = performance.now();
for (const row of workloads) computeNarrativeMetrics(row.views, row.expected, row.actual);
const serialMs = elapsed(serialStart);
console.log(JSON.stringify({ mode: "serial", cases: workloads.length, elapsed_ms: serialMs }));

for (const size of sizes) {
  const pool = new NarrativeScoringPool(size);
  try {
    // Exclude cold thread startup; production reuses workers between cases.
    await pool.compute([], null, "Warmup");
    let ticks = 0;
    let maxGap = 0;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - previous);
      previous = now;
      ticks++;
    }, 5);
    const start = performance.now();
    try {
      // One answered case at a time: this measures within-case parallelism,
      // not just parallel processing of several server responses.
      for (const row of workloads) await pool.compute(row.views, row.expected, row.actual);
    } finally {
      clearInterval(timer);
    }
    const elapsedMs = elapsed(start);
    console.log(
      JSON.stringify({
        mode: "workers",
        workers: size,
        cases: workloads.length,
        elapsed_ms: elapsedMs,
        speedup_vs_serial: Number((serialMs / elapsedMs).toFixed(2)),
        main_thread_timer_ticks: ticks,
        max_timer_gap_ms: Math.round(maxGap),
      }),
    );
  } finally {
    pool.close();
  }
}
