/**
 * OFFLINE end-to-end parity diff (deterministic; no live network).
 *
 * Scores the SAME recorded CES responses BOTH ways and diffs them:
 *   - TS side:  re-runs the NlqHarnessRunner with the scrubbing recorder in
 *               REPLAY mode as its fetchImpl (and a fake session so no signin
 *               network happens), over the captured slice. This proves the TS
 *               path is deterministic from the fixtures.
 *   - Reference side: goldens/e2e/py_results.json, retained
 *               from the identical recorded response bytes.
 *
 * Produces goldens/e2e/parity_report.json and prints a summary comparing, per
 * case and per metric: Python score vs TS score, and Python `actual` extraction
 * vs TS `actual` extraction. Reports exact matches, within-tolerance, and
 * DIVERGENCES with the offending values.
 *
 * Run (offline):
 *   $HOME/.bun/bin/bun run scripts/golden/replay_parity.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NlqHarnessRunner, RateLimiter, type HarnessCase, type ComputedMetric } from "@tableau-ai-eval/evals";
import type { RunConfig } from "@tableau-ai-eval/core";
import { TableauSession } from "@tableau-ai-eval/core";
import {
  buildRunConfig,
  createScrubbingFetch,
  CES_FIXTURES_DIR,
  REPO_ROOT,
  SLICE_CASE_FILES,
  CASES_DIR,
  listFixtures,
} from "./golden_harness.ts";

const E2E_DIR = join(REPO_ROOT, "goldens", "e2e");
const TOLERANCE = 1e-9;

interface MetricRec {
  metric_name: string;
  score: number | null;
}
interface CaseResult {
  id: string;
  utterance: string;
  datasource: string | null;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  metrics: Record<string, MetricRec[]>;
}

function fakeSessionFactory(): (config: RunConfig) => TableauSession {
  return () =>
    new TableauSession({
      serverUrl: "https://replay.invalid",
      patName: "replay",
      patSecret: "replay",
      // fetchImpl never actually hits network for auth in replay because the
      // runner's fetchImpl is the replay recorder; but authHeaders() calls
      // getToken() which would sign in. Stub fetch to mint a token offline.
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ credentials: { token: "REPLAY_TOKEN", site: { id: "s" } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
}

async function loadSliceCases(): Promise<HarnessCase[]> {
  const cases: HarnessCase[] = [];
  for (const file of SLICE_CASE_FILES) {
    const raw = await readFile(join(CASES_DIR, file), "utf-8");
    const doc = JSON.parse(raw) as {
      id?: string;
      runner?: string;
      datasource?: string | null;
      inputs?: Array<{ utterance?: string; expected?: Record<string, unknown> }>;
    };
    const input = doc.inputs?.[0];
    if (!input) continue;
    cases.push({
      id: doc.id ?? file,
      runner: doc.runner ?? "ect-server",
      datasource: doc.datasource == null ? null : String(doc.datasource),
      utterance: input.utterance ?? "",
      turn: 0,
      expected: input.expected ?? {},
    });
  }
  return cases;
}

/** Recover the captured server base URL from a recorded fixture request URL. */
async function capturedServerUrl(): Promise<string> {
  const files = await listFixtures(CES_FIXTURES_DIR);
  for (const f of files) {
    const fx = JSON.parse(await readFile(join(CES_FIXTURES_DIR, f), "utf-8")) as {
      request: { url: string };
    };
    const idx = fx.request.url.indexOf("/content-exploration");
    if (idx > 0) return fx.request.url.slice(0, idx);
  }
  throw new Error("could not recover server URL from ces_fixtures (no /content-exploration URL found)");
}

export async function runTsReplay(): Promise<CaseResult[]> {
  const { fetchImpl } = createScrubbingFetch({
    mode: "replay",
    dir: CES_FIXTURES_DIR,
    secrets: [],
  });
  // The fixture key is derived from method+url+body, so the replay config MUST
  // use the SAME server host that was captured. Recover it from a recorded
  // fixture's request URL (an illustrative example domain).
  const server = await capturedServerUrl();
  const config = buildRunConfig({
    server,
    site: "",
    patName: "replay",
    patValue: "replay",
    verifyTls: false,
  });
  const runner = new NlqHarnessRunner({
    fetchImpl,
    sessionFactory: fakeSessionFactory(),
    rateLimiter: new RateLimiter({ rate: 1000, windowMs: 1, sleep: async () => {} }),
  });
  const cases = await loadSliceCases();
  const out: CaseResult[] = [];
  for (const c of cases) {
    const r = await runner.runCase(c, config, []);
    if (r.errors?.length) {
      throw new Error(`Replay failed for ${c.id}: ${JSON.stringify(r.errors)}`);
    }
    const metrics: Record<string, MetricRec[]> = {};
    for (const [stage, entries] of Object.entries(r.metrics ?? {})) {
      metrics[stage] = entries as ComputedMetric[];
    }
    out.push({
      id: c.id,
      utterance: c.utterance,
      datasource: c.datasource ?? null,
      expected: c.expected ?? {},
      actual: (r.actual ?? {}) as Record<string, unknown>,
      metrics,
    });
  }
  return out;
}

/** Canonicalize an `actual` value for structural comparison. */
function canon(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

interface MetricComparison {
  metric: string;
  ts: number | null;
  python: number | null;
  diff?: number;
  status: string;
}

interface CaseComparison {
  id: string;
  utterance: string;
  stages: Record<string, { actual_agree: boolean | null; metrics: MetricComparison[] }>;
}

interface Divergence {
  id: string;
  kind: string;
  stage: string;
  metric?: string;
  ts: unknown;
  python: unknown;
  diff?: number;
}

async function main() {
  console.log("=== E2E parity diff (offline replay vs Python golden) ===");

  const ts = await runTsReplay();
  const py = JSON.parse(await readFile(join(E2E_DIR, "py_results.json"), "utf-8")) as CaseResult[];

  const pyById = new Map(py.map((c) => [c.id, c]));
  if (ts.length !== py.length || pyById.size !== py.length || new Set(ts.map(c => c.id)).size !== ts.length) {
    throw new Error("Replay and Python baselines must contain the same number of unique cases");
  }

  const report = {
    _generated_by: "replay_parity.ts",
    _note:
      "Python vs TS scored from the SAME recorded (scrubbed) CES responses. " +
      "TS re-run in REPLAY mode from goldens/e2e/ces_fixtures; Python from " +
      "goldens/e2e/py_results.json (independent reference, identical bytes).",
    tolerance: TOLERANCE,
    cases_compared: 0,
    metric_comparisons: 0,
    metric_exact: 0,
    metric_within_tolerance: 0,
    metric_divergences: 0,
    actual_extraction_agreements: 0,
    actual_extraction_divergences: 0,
    per_metric_agreement: {} as Record<string, { exact: number; total: number }>,
    divergences: [] as Divergence[],
    cases: [] as CaseComparison[],
  };

  for (const t of ts) {
    const p = pyById.get(t.id);
    const caseEntry: CaseComparison = { id: t.id, utterance: t.utterance, stages: {} };
    if (!p) {
      throw new Error(`Missing Python baseline for ${t.id}`);
    }
    report.cases_compared++;

    // Compare per-stage `actual` extraction.
    const stages = new Set([...Object.keys(t.actual), ...Object.keys(p.actual)]);
    for (const stage of stages) {
      // TS folds user_friendly_reply into actual; Python does not extract it
      // here (that stage has no expected key). Skip it — not a scored stage.
      if (stage === "user_friendly_reply") continue;
      const tv = t.actual[stage];
      const pv = p.actual[stage];
      const agree = canon(tv) === canon(pv);
      if (agree) report.actual_extraction_agreements++;
      else {
        report.actual_extraction_divergences++;
        report.divergences.push({
          id: t.id,
          kind: "actual_extraction",
          stage,
          ts: tv,
          python: pv,
        });
      }
      caseEntry.stages[stage] = { actual_agree: agree, metrics: [] };
    }

    // Compare per-stage metrics.
    const allStages = new Set([...Object.keys(t.metrics), ...Object.keys(p.metrics)]);
    for (const stage of allStages) {
      const tMetrics = t.metrics[stage] ?? [];
      const pMetrics = p.metrics[stage] ?? [];
      caseEntry.stages[stage] = caseEntry.stages[stage] ?? { actual_agree: null, metrics: [] };
      const names = new Set([
        ...tMetrics.map((m) => m.metric_name),
        ...pMetrics.map((m) => m.metric_name),
      ]);
      for (const name of names) {
        const tm = tMetrics.find((m) => m.metric_name === name);
        const pm = pMetrics.find((m) => m.metric_name === name);
        report.metric_comparisons++;
        report.per_metric_agreement[name] ??= { exact: 0, total: 0 };
        const agg = report.per_metric_agreement[name];
        agg.total++;
        if (!tm || !pm) {
          report.metric_divergences++;
          report.divergences.push({
            id: t.id,
            kind: "metric_presence",
            stage,
            metric: name,
            ts: tm?.score ?? null,
            python: pm?.score ?? null,
          });
          caseEntry.stages[stage].metrics.push({ metric: name, ts: tm?.score ?? null, python: pm?.score ?? null, status: "PRESENCE_DIVERGENCE" });
          continue;
        }
        const diff = tm.score === pm.score ? 0
          : tm.score === null || pm.score === null ? Infinity
          : Math.abs(tm.score - pm.score);
        let status: string;
        if (diff === 0) {
          status = "EXACT";
          report.metric_exact++;
          agg.exact++;
        } else if (diff <= TOLERANCE) {
          status = "WITHIN_TOLERANCE";
          report.metric_within_tolerance++;
          agg.exact++;
        } else {
          status = "DIVERGENCE";
          report.metric_divergences++;
          report.divergences.push({
            id: t.id,
            kind: "metric_score",
            stage,
            metric: name,
            ts: tm.score,
            python: pm.score,
            diff,
          });
        }
        caseEntry.stages[stage].metrics.push({ metric: name, ts: tm.score, python: pm.score, diff, status });
      }
    }
    report.cases.push(caseEntry);
  }

  await writeFile(join(E2E_DIR, "ts_results.json"), JSON.stringify(ts, null, 2) + "\n", "utf8");

  // Print summary.
  console.log(`\nCases compared:                 ${report.cases_compared}`);
  console.log(`Metric comparisons:             ${report.metric_comparisons}`);
  console.log(`  exact:                        ${report.metric_exact}`);
  console.log(`  within tolerance (<=${TOLERANCE}):  ${report.metric_within_tolerance}`);
  console.log(`  DIVERGENCES:                  ${report.metric_divergences}`);
  console.log(`Actual-extraction agreements:   ${report.actual_extraction_agreements}`);
  console.log(`Actual-extraction divergences:  ${report.actual_extraction_divergences}`);
  console.log(`\nPer-metric agreement:`);
  for (const [name, agg] of Object.entries(report.per_metric_agreement)) {
    console.log(`  ${name.padEnd(20)} ${agg.exact}/${agg.total}`);
  }
  if (report.divergences.length) {
    console.log(`\n!!! ${report.divergences.length} DIVERGENCE(S) — see parity_report.json:`);
    for (const d of report.divergences.slice(0, 20)) {
      console.log(`  [${String(d.id).slice(0, 8)}] ${d.kind} ${d.stage ?? ""} ${d.metric ?? ""}: TS=${JSON.stringify(d.ts)} PY=${JSON.stringify(d.python)}`);
    }
  } else {
    console.log(`\nRESULT: FULL PARITY — TS and Python agree on every metric and every actual extraction.`);
  }

  await writeFile(join(E2E_DIR, "parity_report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  process.exit(report.metric_divergences > 0 || report.actual_extraction_divergences > 0 ? 1 : 0);
}

if (import.meta.main) await main();
