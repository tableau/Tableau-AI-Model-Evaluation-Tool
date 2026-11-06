/**
 * Export parity (schema 3): `buildExportFromData` /
 * `toCsv` / `filenameStem` render the SAME inputs the reference export
 * rendered (`goldens/publish/run_inputs.json` →
 * `expected_exports.json`, retained independent reference outputs),
 * and must match: the CSV byte-for-byte, the JSON value-for-value.
 * Plus focused suite and export assertions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FullResults, JobState } from "@tableau-ai-eval/core";
import { buildExportFromData, csvHeader, filenameStem, toCsv, type Export } from "./export.ts";
import { CASE_COLUMNS, COLUMN_MEANINGS, METRIC_COLUMNS, RUN_COLUMNS, pyFloat, pyJson } from "./records.ts";
import { resultsTableDefinition } from "./hyper.ts";

const GOLDEN_DIR = join(import.meta.dir, "..", "..", "..", "..", "goldens", "publish");
const INPUTS = JSON.parse(readFileSync(join(GOLDEN_DIR, "run_inputs.json"), "utf-8")) as {
  fixed_now: string;
  runs: Record<string, { data: FullResults; state: JobState }>;
};
const EXPECTED = JSON.parse(readFileSync(join(GOLDEN_DIR, "expected_exports.json"), "utf-8")) as {
  exports: Record<string, { json: Export; csv: string; filename_stem: string }>;
};
const NOW = () => new Date(INPUTS.fixed_now);

const BEEF = "beefcafe00000000000000000000beef";
const CES = "cafe0000000000000000000000000001";

function exportFor(job: string): Export {
  const { data, state } = INPUTS.runs[job];
  return buildExportFromData(job, structuredClone(data), state, NOW);
}

/** Deep-equal with a float tolerance (float summation order). */
function expectDeepClose(got: unknown, want: unknown, path = "$"): void {
  if (typeof want === "number" && typeof got === "number") {
    if (Math.abs(got - want) > 1e-9) throw new Error(`${path}: ${got} != ${want}`);
    return;
  }
  if (want === null || typeof want !== "object") {
    if (got !== want) throw new Error(`${path}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    return;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length)
      throw new Error(`${path}: array length ${(got as unknown[])?.length} != ${want.length}`);
    want.forEach((w, i) => expectDeepClose(got[i], w, `${path}[${i}]`));
    return;
  }
  const g = got as Record<string, unknown>;
  const wk = Object.keys(want).sort();
  const gk = Object.keys(g ?? {}).sort();
  if (JSON.stringify(wk) !== JSON.stringify(gk))
    throw new Error(`${path}: keys ${JSON.stringify(gk)} != ${JSON.stringify(wk)}`);
  for (const k of wk) expectDeepClose(g[k], (want as Record<string, unknown>)[k], `${path}.${k}`);
}

describe("parity with the export goldens (goldens/publish)", () => {
  for (const job of Object.keys(EXPECTED.exports)) {
    const want = EXPECTED.exports[job];
    test(`${job.slice(0, 8)}: JSON export`, () => {
      expectDeepClose(JSON.parse(JSON.stringify(exportFor(job))), want.json);
    });
    test(`${job.slice(0, 8)}: CSV byte-identical`, () => {
      expect(toCsv(exportFor(job))).toBe(want.csv);
    });
    test(`${job.slice(0, 8)}: file name stem`, () => {
      expect(filenameStem(exportFor(job))).toBe(want.filename_stem);
    });
  }
});

test("direct-gateway run: identity, JSON-only extras, no run-level columns", () => {
  const exp = exportFor(BEEF);
  expect(exp.schema_version).toBe(3);
  const run = exp.run;
  expect(run.run_id).toBe(BEEF);
  expect(run.answered_by).toBe("https://localhost:5001");
  expect(run.model_under_test).toBe("gpt-4o-mini");
  expect(run.run_status).toBe("Completed");
  expect(run.capability_label).toBe("Calculated fields");
  expect(String(run.run_started_at)).toMatch(/T.*Z$/);
  // A row is about one case: the run carries no averages or totals, and none
  // of the columns that only repeated another one.
  for (const gone of [
    "run_overall_score", "run_viz_quality_score", "run_nl_quality_score",
    "run_cases_total", "run_cases_completed", "run_cases_scored",
    "run_cases_with_errors", "run_cases_pass", "run_cases_partial",
    "run_cases_fail", "run_avg_latency_s", "model_source", "path",
  ]) {
    expect(gone in run).toBe(false);
  }
  expect(run.suite_case_count).toBe(2);
  expect(run.models).toEqual({ create: "gpt-4o-mini" });
  expect((run.local as Record<string, unknown>).test_path).toBe("/tests/sample-calcs");
  expect("org_id" in run).toBe(false);
  expect("test_path" in run).toBe(false);
  // The summary is where the run's averages and totals live, once.
  const summary = exp.summary as unknown as Record<string, unknown>;
  expect("overall_score" in summary).toBe(false);
  expect(summary.viz_quality_score).toBeNull();
  expect(summary.nl_quality_score as number).toBeCloseTo(0.9, 9);
  expect(summary.cases_total).toBe(2);
  expect(summary.cases_scored).toBe(2);
  expect(summary.verdicts).toEqual({ pass: 1, partial: 1, fail: 0, na: 0 });
  const [c1, c2] = exp.cases;
  expect(c1.expected_kind).toBe("formula");
  expect(c1.case_verdict).toBe("pass");
  expect(c2.case_verdict).toBe("partial");
  expect(c2.errors_text).toBe("slow gateway");
  expect(exp.metric_dictionary["llmJudge.coherence"].judge_derived).toBe(true);
  expect(exp.column_dictionary.case_score).toBeTruthy();
  expect("run_overall_score" in exp.column_dictionary).toBe(false);
  expect(JSON.stringify(exp)).not.toContain("sk-super-secret-9876");
});

test("customer-path run: server/site/model named, never the loopback bridge (S2-7/S2-8)", () => {
  const exp = exportFor(CES);
  const run = exp.run;
  expect(run.tableau_server_url).toBe("https://tableau.example.com");
  expect(run.tableau_site).toBe("Sales");
  expect(run.answered_by).toBe("https://tableau.example.com/content-exploration");
  expect(run.model_under_test).toBe("claude-sonnet-4-6");
  expect(run.suite_id).toBe("calcs-public"); // JSON only: not a column
  expect(run.run_status).toBe("Paused");
  expect(run.run_finished_at).toBeNull();
  expect(exp.summary.cases_with_errors).toBe(1); // the warning is not an error
  const csv = toCsv(exp);
  expect(csv).not.toContain("127.0.0.1");
  expect(csv).not.toContain("secret-pat");
  expect(csvHeader(exp)).not.toContain("suite_id");
  expect(csvHeader(exp)).not.toContain("run_overall_score");
});

test("CSV header: run + case columns in records order, then sorted metric columns", () => {
  const exp = exportFor(BEEF);
  const fixed = [...RUN_COLUMNS, ...CASE_COLUMNS].map(([n]) => n);
  const header = csvHeader(exp);
  expect(header.slice(0, fixed.length)).toEqual(fixed);
  expect(header.slice(fixed.length)).toEqual([
    "calculatedFieldFormula.calcValidity",
    "llmJudge.coherence",
  ]);
});

test("every column has a meaning (the JSON column/metric dictionaries)", () => {
  const cols = [...RUN_COLUMNS, ...CASE_COLUMNS, ...METRIC_COLUMNS].map(([n]) => n);
  expect(cols.filter((n) => !COLUMN_MEANINGS[n])).toEqual([]);
  expect(new Set(cols).size).toBe(cols.length);
});

test("pyFloat / pyJson reproduce Python repr + compact json.dumps", () => {
  expect(pyFloat(1)).toBe("1.0");
  expect(pyFloat(0.1 + 0.2)).toBe("0.30000000000000004");
  expect(pyFloat(1e-5)).toBe("1e-05");
  expect(pyFloat(1e16)).toBe("1e+16");
  expect(pyFloat(123456.5)).toBe("123456.5");
  expect(pyJson({ a: [1, "é", null, true], b: { c: "x\"y" } })).toBe(
    '{"a":[1,"\\u00e9",null,true],"b":{"c":"x\\"y"}}',
  );
});

test("docs/EXPORT_COLUMNS.md documents every export column", () => {
  // A column added to records.ts without a line in the doc would be a column
  // an admin cannot interpret.
  const doc = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "EXPORT_COLUMNS.md"), "utf-8");
  const cols = [...RUN_COLUMNS, ...CASE_COLUMNS, ...METRIC_COLUMNS].map(([n]) => n);
  expect(cols.filter((n) => !doc.includes(`| \`${n}\` |`))).toEqual([]);
});

// ---------------------------------------------------------------------------
// One export for every runner (36d4ed94 test_every_runner_exports_the_same_columns).
// ---------------------------------------------------------------------------

// One (capability, runner, adapter, expected answer, expected_kind) per runner.
const RUNNER_SHAPES: Array<[string, string, string | null, Record<string, unknown>, string]> = [
  ["calc", "ect-server", null, { calculatedFieldFormula: { formula: "SUM([Sales])" }, intent: "calc" }, "formula"],
  ["calc", "calc-prompt", null, { calculatedFieldFormula: "SUM([Sales])" }, "formula"],
  ["viz-authoring", "ect-server", null, { intent: "viz", notionalSpec: { chart: "bar" } }, "viz_spec"],
  ["palettes", "color-palettes-server", "palettes", { colorPalette: ["#112233"] }, "palette"],
  ["dashboard-narratives", "dashboard-viz-narrative-config", null, { insightNarrative: "Sales rose." }, "narrative"],
  ["dashboard-qa", "cabu-dashboard-qa", "cabu", { user_friendly_reply: "A, B, C", output_types: ["Metrics"] }, "reply"],
  ["prep-calc", "prep-calc-gen", "prep", { calculation: "[Profit] / [Sales]" }, "formula"],
  ["prep-flow-plan", "prep-flow-plan-gen", "prep", { flowPlan: ["FilterValues"] }, "plan"],
  ["prep-intent", "prep-intent-gen", "prep", { intent: "calc" }, "intent"],
];

const REMOVED_COLUMNS = [
  "org_id", "suite_id", "suite_label", "model_source", "path", "run_overall_score",
  "run_viz_quality_score", "run_nl_quality_score", "run_cases_total", "run_cases_completed",
  "run_cases_scored", "run_cases_with_errors", "run_cases_pass", "run_cases_partial",
  "run_cases_fail", "run_avg_latency_s", "gateway_url", "declared_site_model", "models", "test_path",
];

/** Parse one CSV header + one row (RFC 4180 quoting). */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); out.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

describe("every runner exports the same columns", () => {
  for (const [capability, runner, adapter, expected, kind] of RUNNER_SHAPES) {
    test(`${capability}:${runner}`, () => {
      const job = `feed${capability}${runner}`.replace(/[^a-z0-9]/g, "").padEnd(32, "0").slice(0, 32);
      const cfg: Record<string, unknown> = {
        runner, generations_mode: "ces", suite_id: `${capability}-suite`,
        tableau_server: "https://tableau.example.com", tableau_site: "Sales",
        tableau_server_url: "https://tableau.example.com", tableau_site_name: "Sales",
        tableau_site_luid: "site-luid-9",
        tableau_server_version: "2026.1.0 (20261.26.0415.1010)",
        resolved_site_model: "claude-sonnet-4-6", site_model_provider: "bring-your-own-llm",
        tool_version: "1.2.0",
      };
      if (adapter) cfg.adapter = adapter;
      const data = {
        run: {
          job_id: job, org_id: "", user_id: "user", ai_feature: capability, runner_name: runner,
          config: cfg, status: "finished", total: 1, completed: 1, error: null,
          created_at: "2026-09-30 10:00:00", finished_at: "2026-09-30 10:05:00",
        },
        metrics: [],
        errors: [],
        results: [{
          id: 1, job_id: job, test_case_id: "tc-1", runner, datasource: "Superstore",
          utterance: "a request", expected, actual: expected, latency: 1.5,
          debug_info: null, info: null, created_at: "2026-09-30 10:01:00",
        }],
      } as unknown as FullResults;
      const exp = buildExportFromData(job, data, { status: "finished", total: 1, completed: 1 }, NOW);

      const fixed = [...RUN_COLUMNS, ...CASE_COLUMNS].map(([n]) => n);
      const [header, row] = parseCsv(toCsv(exp));
      expect(header!.slice(0, fixed.length)).toEqual(fixed);
      expect(header!.filter((h) => REMOVED_COLUMNS.includes(h))).toEqual([]);
      const r = Object.fromEntries(header!.map((h, i) => [h, row![i]]));
      expect(r.expected_kind).toBe(kind);
      expect(r.capability).toBe(capability);
      expect(["", capability]).not.toContain(r.capability_label);
      expect(r.tableau_server_url).toBe("https://tableau.example.com");
      expect(r.tableau_site).toBe("Sales");
      expect(r.tableau_site_luid).toBe("site-luid-9");
      expect(r.tableau_server_version).toBe("2026.1.0 (20261.26.0415.1010)");
      expect(r.model_under_test).toBe("claude-sonnet-4-6");
      expect(r.answered_by!.startsWith("https://tableau.example.com")).toBe(true);
      expect(r.tool_version).toBe("1.2.0");
      expect(r.suite_case_count).toBe("1");

      const jsonOnly = new Set(["suite_id", "suite_label", "models", "declared_site_model"]);
      expect(Object.keys(exp.run).filter((k) => REMOVED_COLUMNS.includes(k) && !jsonOnly.has(k))).toEqual([]);

      // The published table carries the same run + case columns, then the metric ones.
      expect(resultsTableDefinition().getColumns().map((c) => c.name)).toEqual([
        ...fixed,
        ...METRIC_COLUMNS.map(([n]) => n),
      ]);
    });
  }
});
