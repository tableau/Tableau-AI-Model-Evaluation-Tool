/** Strict offline request replay and scoring parity against the Python oracle. */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeKey } from "../../packages/server/src/bridge/record_replay.ts";
import { CES_FIXTURES_DIR, REPO_ROOT, type E2EFixture } from "./golden_harness.ts";
import { runTsReplay } from "./replay_parity.ts";

interface BaselineCase {
  id: string;
  actual: Record<string, unknown>;
  metrics: Record<string, Array<{ metric_name: string; score: number | null }>>;
}

test("calc replay fixture filenames match the stored, anonymized requests", () => {
  const files = readdirSync(CES_FIXTURES_DIR).filter(f => f.endsWith(".json"));
  expect(files.length).toBe(7);
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(CES_FIXTURES_DIR, file), "utf8")) as E2EFixture;
    const { method, url, normalizedBody } = fixture.request;
    expect(file).toBe(`${computeKey(method, url, normalizedBody)}.json`);
  }
});

test("calc harness strictly replays all requests and matches current Python scores", async () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "goldens", "e2e", "py_results.json"), "utf8")) as BaselineCase[];
  const replay = await runTsReplay();
  const storedReplay = JSON.parse(readFileSync(join(REPO_ROOT, "goldens", "e2e", "ts_results.json"), "utf8"));
  expect(replay).toEqual(storedReplay);
  expect(replay.map(c => c.id).sort()).toEqual(baseline.map(c => c.id).sort());
  expect(replay.length).toBe(5);
  const byId = new Map(baseline.map(c => [c.id, c]));
  expect(byId.size).toBe(baseline.length);
  let comparisons = 0;
  let extractions = 0;
  for (const result of replay) {
    const reference = byId.get(result.id)!;
    const { user_friendly_reply: _reply, ...actual } = result.actual;
    expect(actual).toEqual(reference.actual);
    extractions += Object.keys(actual).length;
    expect(Object.keys(result.metrics).sort()).toEqual(Object.keys(reference.metrics).sort());
    for (const [stage, entries] of Object.entries(result.metrics)) {
      expect(entries.map(m => m.metric_name).sort()).toEqual(reference.metrics[stage].map(m => m.metric_name).sort());
      for (const entry of entries) {
        const expected = reference.metrics[stage].find(m => m.metric_name === entry.metric_name)!;
        expect(entry.score, `${result.id}.${stage}.${entry.metric_name}`).toBe(expected.score);
        comparisons++;
      }
    }
  }
  expect(comparisons).toBe(35);
  expect(extractions).toBe(10);
  const report = JSON.parse(readFileSync(join(REPO_ROOT, "goldens", "e2e", "parity_report.json"), "utf8"));
  expect(report.cases_compared).toBe(replay.length);
  expect(report.metric_comparisons).toBe(comparisons);
  expect(report.metric_exact).toBe(comparisons);
  expect(report.actual_extraction_agreements).toBe(extractions);
  expect(report.metric_divergences).toBe(0);
  expect(report.actual_extraction_divergences).toBe(0);
  expect(report.divergences).toEqual([]);
});
