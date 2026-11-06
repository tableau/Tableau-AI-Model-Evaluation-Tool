/**
 * Score a finished run again with the tool's current chart metrics.
 * Uses only stored answers for deterministic metrics.
 *
 * The chart metrics (stage `vizQuality`, `@tableau-ai-eval/evals` `metrics/viz.ts`) are
 * computed by the tool from the expected and actual chart definitions the run
 * stored, so a run does not have to be repeated when those metrics change:
 * `rescoreVizQuality(db, jobId)` recomputes them from the stored rows,
 * replaces the stage's metric rows, adds the warning a case without an
 * expected chart now carries, and drops the run's cached home-page scores so
 * they are computed again from the new rows. The evaluator's own metrics
 * (intent, precision, recall, field validity) and the judge's are left alone.
 *
 * The Tableau Prep calculation and intent suites are scored by the bench that
 * ships with the tool, from the stored answer and the case's own data, so
 * `rescorePrep(db, jobId)` recomputes those too (Calculation Validity,
 * Formula Similarity, Intent Match). Latency is not a
 * score and cannot be recomputed. `rescoreRun` picks the right one for a run.
 *
 *     tableau-ai-eval rescore <job_id> [<job_id> ...]
 *     tableau-ai-eval rescore --all
 */

import type { AiEvalDb } from "@tableau-ai-eval/core";
import {
  computeNarrativeJudgeMetrics,
  callJudge as callProviderJudge,
  DEFAULT_RETRY_POLICY,
  NARRATIVE_JUDGE_METRIC_NAMES,
  type JudgeConfig,
  type NarrativeTruths,
} from "@tableau-ai-eval/core";
import { join } from "node:path";
import {
  bestFormulaSimilarity,
  checkCalc,
  computeToolMetrics,
  flattenPrepSuite,
  intentScore,
  NO_EXPECTED_CHART_WARNING,
  normalizeIntent,
  stableJson,
  UNCHANGED_CHART_KEY,
  parseFieldMetadata,
  serializePrepCase,
  VIZ_STAGE,
  prepCasesBase,
  answerForJudging,
  computeCabuJudgeMetrics,
  type JudgeCaller,
} from "@tableau-ai-eval/evals";

export interface RescoreCounts {
  cases: number;
  scored: number;
  no_expected_chart: number;
  not_a_chart_case: number;
  unanswered: number;
  /** Follow-ups answered without a chart, scored on the chart that stood. */
  unchanged: number;
}

/**
 * The rows in conversation order: a follow-up (`<id>:<n>`) after the turns
 * before it, so the chart that stands is known when a turn is reached. Rows
 * are stored in that order already; this makes sure. `_conversation_order`.
 */
function conversationOrder<T extends { test_case_id: unknown }>(rows: T[]): T[] {
  const key = (row: T, position: number): [string, number, number] => {
    const caseId = String(row.test_case_id ?? "");
    const at = caseId.lastIndexOf(":");
    const conv = at >= 0 ? caseId.slice(0, at) : caseId;
    const turn = at >= 0 ? caseId.slice(at + 1) : "";
    return [conv || caseId, /^\d+$/.test(turn) ? Number(turn) : 0, position];
  };
  return rows
    .map((row, i) => ({ row, k: key(row, i) }))
    .sort((a, b) => (a.k[0] < b.k[0] ? -1 : a.k[0] > b.k[0] ? 1 : a.k[1] - b.k[1] || a.k[2] - b.k[2]))
    .map((x) => x.row);
}

/** The day the run was made, for relative date filters. `_run_date`. */
function runDate(run: { started_at?: unknown; created_at?: unknown } | null): Date | null {
  for (const value of [run?.started_at, run?.created_at]) {
    if (typeof value === "string" && value.length >= 10) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
  }
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function reply(actual: unknown): string | null {
  if (!isObj(actual)) return null;
  return ((actual.user_friendly_reply || actual.userFriendlyReply) as string) || null;
}

function expectedReply(expected: unknown): string | null {
  if (!isObj(expected)) return null;
  return ((expected.userFriendlyReply || expected.user_friendly_reply) as string) || null;
}

/** Python truthiness of a stored JSON value. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * Recompute the `vizQuality` metrics of every stored case of a run. Returns
 * counts: cases looked at, cases scored, cases skipped for having no expected
 * chart (now warned), cases with no chart in the suite (calculations and the
 * like, untouched), cases the server never answered, and cases that answered
 * without a chart and were scored on the chart that stood (`unchanged`). A
 * follow-up answered without a chart is scored on the last chart of its
 * conversation, as the live path does, and the stored answer records that
 * chart under `unchanged_chart`.
 */
export function rescoreVizQuality(db: AiEvalDb, jobId: string): RescoreCounts {
  const rows = db.getResults(jobId);
  const counts: RescoreCounts = {
    cases: rows.length,
    scored: 0,
    no_expected_chart: 0,
    not_a_chart_case: 0,
    unanswered: 0,
    unchanged: 0,
  };
  if (!rows.length) return counts;
  const referenceDate = runDate(db.getRun(jobId) as { started_at?: unknown; created_at?: unknown } | null);
  const standing = new Map<string, Record<string, unknown>>();
  const existingWarnings = new Set(
    db
      .getErrors(jobId)
      .filter((e) => e.is_warning)
      .map((e) => `${e.test_case_id}\u0000${e.description ?? ""}`),
  );
  db.db.query("DELETE FROM test_metrics WHERE job_id = ? AND stage = ?").run(jobId, VIZ_STAGE);
  for (const row of conversationOrder(rows)) {
    const expected = truthy(row.expected) ? row.expected : {};
    let actual = truthy(row.actual) ? row.actual : {};
    const caseId = String(row.test_case_id);
    const at = caseId.lastIndexOf(":");
    const conversation = at >= 0 ? caseId.slice(0, at) : caseId;
    if (!isObj(expected) || !("notionalSpec" in expected)) {
      counts.not_a_chart_case += 1;
      continue;
    }
    if (!isObj(expected.notionalSpec)) {
      counts.no_expected_chart += 1;
      if (!existingWarnings.has(`${caseId}\u0000${NO_EXPECTED_CHART_WARNING}`)) {
        db.insertTestErrors(jobId, caseId, [
          { phase: "evaluateResult", description: NO_EXPECTED_CHART_WARNING, warning: true },
        ]);
      }
      continue;
    }
    if (!truthy(actual)) {
      // The server never answered (a run error): the live path scores nothing
      // for such a case, and neither does this.
      counts.unanswered += 1;
      continue;
    }
    let carried: Record<string, unknown> | null = null;
    if (isObj(actual)) {
      if (isObj(actual.notionalSpec)) {
        standing.set(conversation, actual.notionalSpec);
      } else if (actual.intent === expected.intent && standing.has(conversation)) {
        carried = standing.get(conversation)!;
        counts.unchanged += 1;
        if (stableJson(actual[UNCHANGED_CHART_KEY]) !== stableJson(carried)) {
          actual = { ...actual, [UNCHANGED_CHART_KEY]: carried };
          db.db
            .query("UPDATE test_results SET actual = ? WHERE job_id = ? AND test_case_id = ?")
            .run(JSON.stringify(actual), jobId, caseId);
        }
      }
    }
    const entries = computeToolMetrics(expected, isObj(actual) ? actual : null, {
      expectedReply: expectedReply(expected),
      actualReply: reply(actual),
      carriedSpec: carried,
      referenceDate,
    });
    if (entries.length) {
      db.insertTestMetrics(jobId, caseId, VIZ_STAGE, entries);
      counts.scored += 1;
    }
  }
  forgetCachedScores(db, jobId);
  return counts;
}

/**
 * The home page keeps each finished run's scores; forget this run's so they
 * are computed again from the new rows.
 */
function forgetCachedScores(db: AiEvalDb, jobId: string): void {
  const state = db.getJobState(jobId) as Record<string, unknown>;
  if (state && ("headline_scores" in state || "score_version" in state)) {
    delete state.headline_scores;
    delete state.score_version;
    delete state.overall_score;
    db.db
      .query("UPDATE job_state SET state = ?, updated_at = datetime('now') WHERE job_id = ?")
      .run(JSON.stringify(state), jobId);
  }
}

/** Rejudge chosen narrative dimensions without rerunning the server request. */
export async function rescoreNarrativeJudge(
  db: AiEvalDb,
  jobId: string,
  judgeCfg: JudgeConfig,
  names: Iterable<string> = NARRATIVE_JUDGE_METRIC_NAMES,
): Promise<{ cases: number; judged: number; skipped: number }> {
  const rows = db.getResults(jobId);
  const wanted = new Set(names);
  const counts = { cases: rows.length, judged: 0, skipped: 0 };
  for (const row of rows) {
    const actual = isObj(row.actual) ? row.actual : {};
    if (!actual.insightNarrative) {
      counts.skipped++;
      continue;
    }
    const expected = isObj(row.expected) ? row.expected : {};
    const debug = isObj(row.debug_info) ? row.debug_info : {};
    const entries = (
      await computeNarrativeJudgeMetrics({
        expectedNarrative: expected.insightNarrative,
        actualNarrative: actual.insightNarrative,
        truths: debug.narrative_truths as NarrativeTruths | undefined,
        judgeCfg,
      })
    ).filter((entry) => wanted.has(entry.metric_name));
    if (!entries.length) {
      counts.skipped++;
      continue;
    }
    for (const entry of entries) {
      db.db
        .query(
          "DELETE FROM test_metrics WHERE job_id = ? AND test_case_id = ? AND stage = 'llmJudge' AND metric_name = ?",
        )
        .run(jobId, String(row.test_case_id), entry.metric_name);
    }
    db.insertTestMetrics(jobId, String(row.test_case_id), "llmJudge", entries);
    counts.judged++;
  }
  forgetCachedScores(db, jobId);
  return counts;
}

export function rescoreNarrativeSimilarity(db: AiEvalDb, jobId: string, judgeCfg: JudgeConfig) {
  return rescoreNarrativeJudge(db, jobId, judgeCfg, ["llmIsSimilar"]);
}

/** Remove obsolete Q&A metrics and rejudge chart-token answers from stored rows. */
export async function rescoreDashboardQa(
  db: AiEvalDb,
  jobId: string,
  judgeCfg: JudgeConfig | null,
  callJudge: JudgeCaller = (args) =>
    callProviderJudge({ ...args, fetchFn: fetch, retry: DEFAULT_RETRY_POLICY }),
): Promise<{ cases: number; dropped: number; factual_judged: number; rejudged: number }> {
  const rows = db.getResults(jobId);
  const counts = { cases: rows.length, dropped: 0, factual_judged: 0, rejudged: 0 };
  counts.dropped += db.db
    .query("DELETE FROM test_metrics WHERE job_id = ? AND stage = 'dashboardQA'")
    .run(jobId).changes;
  counts.dropped += db.db
    .query(
      "DELETE FROM test_metrics WHERE job_id = ? AND stage = 'llmJudge' AND metric_name IN ('coherence','factualGrounding','followUpRelevance','insightfulness')",
    )
    .run(jobId).changes;
  if (judgeCfg) {
    const have = new Set(
      db
        .getMetrics(jobId)
        .filter((m) => m.metric_name === "factualConsistency")
        .map((m) => m.test_case_id),
    );
    for (const row of rows) {
      const answer = reply(row.actual);
      const actual = isObj(row.actual) ? row.actual : {};
      if (!answer && !actual.semantic_query) continue;
      const debug = isObj(row.debug_info) ? row.debug_info : {};
      const queryRows = debug.query_response_data;
      const replaceToken =
        Array.isArray(queryRows) &&
        queryRows.length > 0 &&
        /<(?:chart|datatable|table)\d+>/.test(answer || "");
      const wanted = new Set<string>();
      if (!have.has(row.test_case_id)) wanted.add("factualConsistency");
      if (replaceToken)
        for (const name of [
          "answerCorrectness",
          "coherence_dashboard_qa",
          "relevance_dashboard_qa",
        ])
          wanted.add(name);
      if (!wanted.size) continue;
      const expected = isObj(row.expected) ? row.expected : {};
      const truth = expectedReply(expected) || "";
      const entries = (
        await computeCabuJudgeMetrics({
          question: String(row.utterance || ""),
          observedAnswer: answerForJudging(answer || "", queryRows),
          expectedAnswer: truth,
          queryResponseData: queryRows || [],
          judgeCfg,
          callJudge,
          expectedProse: truth,
          outputType: String(expected.output_type || "SQ"),
          answerSource: "ANSWER_SOURCE_SEMANTIC_QUERY",
          rowsKnown:
            (Array.isArray(queryRows) && queryRows.length > 0) ||
            Boolean(isObj(row.actual) ? row.actual.semantic_query : null) ||
            Boolean(debug.llm_calls) ||
            Boolean(debug.total_tokens),
        })
      ).filter((entry) => wanted.has(entry.metric_name));
      for (const entry of entries)
        db.db
          .query(
            "DELETE FROM test_metrics WHERE job_id = ? AND test_case_id = ? AND stage = 'llmJudge' AND metric_name = ?",
          )
          .run(jobId, row.test_case_id, entry.metric_name);
      if (entries.length) db.insertTestMetrics(jobId, row.test_case_id, "llmJudge", entries);
      if (wanted.has("factualConsistency")) counts.factual_judged++;
      if (replaceToken) counts.rejudged++;
    }
  }
  forgetCachedScores(db, jobId);
  return counts;
}

/** The Prep suites the shipped bench can score again: runner -> [kind, metric stage]. */
const PREP_RESCORABLE: Record<string, ["calc-gen" | "intent-gen", string]> = {
  "prep-calc-gen": ["calc-gen", "calculatedFieldFormula"],
  "prep-intent-gen": ["intent-gen", "intent"],
};

export interface PrepRescoreCounts {
  cases: number;
  scored: number;
  unanswered: number;
  unknown_case: number;
}

/** The Prep runner a run's rows name, when it is one that can be rescored. */
export function prepRunnerOf(rows: { runner?: unknown }[]): string | null {
  const runners = new Set(rows.map((r) => r.runner));
  for (const runner of Object.keys(PREP_RESCORABLE)) if (runners.has(runner)) return runner;
  return null;
}

/**
 * Recompute the bench-scored metrics of a stored Prep calculation or intent
 * run: cases looked at, scored, never answered or unreadable (left as they
 * are), no longer in the suite.
 */
export function rescorePrep(db: AiEvalDb, jobId: string, root?: string): PrepRescoreCounts {
  const rows = db.getResults(jobId);
  const counts: PrepRescoreCounts = {
    cases: rows.length,
    scored: 0,
    unanswered: 0,
    unknown_case: 0,
  };
  const runner = prepRunnerOf(rows);
  if (!rows.length || runner === null) return counts;
  const [kind, stage] = PREP_RESCORABLE[runner]!;
  const base = root ? join(root, "test", "test-cases") : prepCasesBase();
  if (!base) throw new Error("Prep cases not found: public-suites/prep is missing");
  const records = new Map(
    flattenPrepSuite(
      join(base, kind),
      kind,
      undefined,
      true,
    ).map((c) => [c.caseId, c.record]),
  );
  const genStage = kind === "calc-gen" ? "calc_generator" : "intent_generator";
  const scoreStage = kind === "calc-gen" ? "calc_scorer" : "intent_scorer";
  for (const row of rows) {
    const caseId = String(row.test_case_id);
    const rec = records.get(caseId);
    if (!rec) {
      counts.unknown_case += 1;
      continue;
    }
    const actual = row.actual;
    if (!isObj(actual) || !Object.keys(actual).length || "raw_reply" in actual) {
      counts.unanswered += 1;
      continue;
    }
    let gen: Record<string, unknown>;
    let score: Record<string, unknown>;
    if (kind === "calc-gen") {
      gen = {
        "actual-calc": actual.calculation || "",
        "user-friendly-explanation": actual.user_friendly_reply,
      };
      const problems = checkCalc(gen["actual-calc"], parseFieldMetadata(rec["field-metadata"]));
      const [similarity, explanation] = bestFormulaSimilarity(
        rec["expected-calc"] || "",
        rec["acceptable-calcs"],
        gen["actual-calc"],
      );
      score = {
        "obeys-tableau-expression-grammar": problems.length === 0,
        problems,
        "error-message": problems.join("; "),
        "levenshtein-similarity": similarity,
        "similarity-explanation": explanation,
      };
    } else {
      gen = { "intent-detected": actual.intent || "" };
      const detected = normalizeIntent(gen["intent-detected"]);
      const expected = normalizeIntent(rec["expected-intent"]);
      const value = intentScore(detected, expected, rec["plausible-intents"]);
      score = {
        "determined-correct-intent": value === 1,
        "intent-score": value,
        "intent-detected": detected,
        "expected-intent": expected,
      };
    }
    const entries =
      serializePrepCase(kind, caseId, rec, { [genStage]: gen, [scoreStage]: score })
        .metrics[stage] ?? [];
    db.db
      .query("DELETE FROM test_metrics WHERE job_id = ? AND test_case_id = ? AND stage = ?")
      .run(jobId, caseId, stage);
    if (entries.length) db.insertTestMetrics(jobId, caseId, stage, entries);
    counts.scored += 1;
  }
  forgetCachedScores(db, jobId);
  return counts;
}

export type RunRescoreCounts =
  | ({ kind: "chart" } & RescoreCounts)
  | ({ kind: "prep" } & PrepRescoreCounts);

/** Rescore a run with whichever of the tool's metrics apply to it. */
export function rescoreRun(db: AiEvalDb, jobId: string): RunRescoreCounts {
  if (prepRunnerOf(db.getResults(jobId)) !== null)
    return { kind: "prep", ...rescorePrep(db, jobId) };
  return { kind: "chart", ...rescoreVizQuality(db, jobId) };
}

/** The runs of a Prep suite the shipped bench can score again. */
export function prepRunIds(db: AiEvalDb): string[] {
  const runners = Object.keys(PREP_RESCORABLE);
  return db.db
    .query<{ job_id: string }, string[]>(
      `SELECT DISTINCT job_id FROM test_results WHERE runner IN (${runners.map(() => "?").join(",")}) ORDER BY job_id`,
    )
    .all(...runners)
    .map((r) => r.job_id);
}

/** Every run `rescoreRun` can do something with. */
export function rescorableRunIds(db: AiEvalDb): string[] {
  return [...new Set([...chartRunIds(db), ...prepRunIds(db)])].sort();
}

/** The runs that have at least one case with an expected chart. */
export function chartRunIds(db: AiEvalDb): string[] {
  return db.db
    .query<{ job_id: string }, []>(
      `SELECT DISTINCT job_id FROM test_results WHERE expected LIKE '%"notionalSpec"%' ORDER BY job_id`,
    )
    .all()
    .map((r) => r.job_id);
}

export function rescoreMany(
  db: AiEvalDb,
  jobIds: Iterable<string>,
): Record<string, RunRescoreCounts> {
  const out: Record<string, RunRescoreCounts> = {};
  for (const jobId of jobIds) out[jobId] = rescoreRun(db, jobId);
  return out;
}

/**
 * `tableau-ai-eval rescore <job_id…> | --all`: recompute the tool's own metrics (chart
 * metrics, Prep calculation and intent scores) for stored runs, so a metric
 * change reaches past runs without repeating them.
 * Run ids may be given as prefixes. Returns a process exit code.
 */
export function rescoreCommand(
  db: AiEvalDb,
  argv: string[],
  write: (s: string) => void = (s) => process.stdout.write(s),
): number {
  const all = argv.includes("--all");
  const prefixes = argv.filter((a) => !a.startsWith("-"));
  let jobIds: string[];
  if (all) {
    jobIds = rescorableRunIds(db);
  } else {
    const known = rescorableRunIds(db);
    jobIds = [];
    for (const prefix of prefixes) {
      const matches = known.filter((j) => j.startsWith(prefix));
      if (matches.length !== 1) {
        write(
          `${prefix}: ${matches.length === 0 ? "no" : matches.length} run${matches.length !== 1 ? "s" : ""} that can be scored again match\n`,
        );
        return 2;
      }
      jobIds.push(matches[0]!);
    }
  }
  if (!jobIds.length) {
    write("Nothing to score: name a run id or pass --all.\n");
    return 2;
  }
  for (const [jobId, counts] of Object.entries(rescoreMany(db, jobIds))) {
    if (counts.kind === "prep") {
      write(
        `${jobId}: ${counts.scored} Prep cases scored again, ` +
          `${counts.unanswered} without an answer left as they were, ` +
          `${counts.unknown_case} no longer in the suite\n`,
      );
    } else {
      write(
        `${jobId}: ${counts.scored} chart cases scored again, ` +
          `${counts.no_expected_chart} without an expected chart left unscored, ` +
          `${counts.not_a_chart_case} other cases untouched\n`,
      );
    }
  }
  write("Restart the tool if it is running, so the pages read the new scores.\n");
  return 0;
}
