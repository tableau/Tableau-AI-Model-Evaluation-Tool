/** Tableau Prep's server pipeline, not the bench's prompt-only gateway path. */
import { isAbsolute, join } from "node:path";
import {
  contentExists,
  contentReadText,
  register,
  resolveMaxConcurrency,
  resolveRequestsPerMinute,
  tlsInit,
  type AdapterSession,
  type EmitCase,
  type EvalAdapter,
  type RowPayload,
  type RunConfig,
  type ShouldStop,
  type SuitePlan,
} from "@tableau-ai-eval/core";
import { RateLimiter } from "../harness/nlq_runner.ts";
import {
  dataName,
  flattenSuite,
  isStepList,
  prepRoot,
  resolveSuite,
  type PrepCase,
  type PrepRecord,
  type SuiteKind,
} from "../prep/bench.ts";
import { bestFormulaSimilarity, checkCalc, parseFieldMetadata } from "../prep/calc_checker.ts";
import { intentExplanation, intentScore, normalizeIntent } from "../prep/intent.ts";
import {
  expectedDict,
  extractJsonObject,
  flowPlanMetrics,
  planStepNames,
} from "../prep/serialize.ts";
import { postPalette, sessionFor } from "./palettes.ts";

const INTENTS: Record<SuiteKind, string> = {
  "calc-gen": "CALC_PREP",
  "flow-plan-gen": "GENERATE_FLOW_PLAN_PREP_COPILOT",
  "intent-gen": "DETECT_INTENT_PREP_COPILOT",
};
const HEADERS = {
  Accept: "application/vnd.analytics-assistant.conversations.v4.0+json",
  "Content-Type": "application/json",
  "Accept-Charset": "UTF-8",
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const DATATYPES: Record<string, string> = {
  int: "integer",
  integer: "integer",
  real: "real",
  float: "real",
  double: "real",
  decimal: "real",
  number: "number",
  string: "string",
  str: "string",
  text: "string",
  date: "date",
  datetime: "datetime",
  bool: "boolean",
  boolean: "boolean",
  geographic: "geographic",
  spatial: "geographic",
};

/** Inline field metadata uses server type names, not the bench's aliases. */
export function prepFieldsMetadata(metadata: unknown, name: string): Record<string, unknown> {
  const fields = [...String(metadata || "").matchAll(/'([^']+)'\s*\(([^)]*)\)/g)].map((m) => ({
    name: m[1],
    caption: m[1],
    datatype: DATATYPES[m[2].trim().toLowerCase()] || "string",
  }));
  return { datasourceIdentifier: name || "prep-flow", name: name || "prep-flow", fields };
}

/** Every Prep intent requires datasourceMetadata, even when its fields are empty. */
export function prepServerRequest(kind: SuiteKind, rec: PrepRecord): Record<string, unknown> {
  const context: Record<string, unknown> = { "prep.flowPlan.spatialCalcs": false };
  if (kind === "flow-plan-gen") context["prep.flowPlan.userDataString"] = rec.user_data || "";
  return {
    intentApplicationAccepts: [{ intent: INTENTS[kind] }],
    utterance: { content: rec.canonical },
    conversationContext: {
      conversationHistory: (Array.isArray(rec.history) ? rec.history : []).map((turn) => ({
        utterance: { content: turn, source: "user" },
      })),
      context,
    },
    datasourceMetadata:
      kind === "calc-gen"
        ? prepFieldsMetadata(rec["field-metadata"], rec["flow-name"] || "")
        : { datasourceIdentifier: "prep-flow", name: "prep-flow", fields: [] },
  };
}

export function prepReplyKind(text: unknown): "question" | "decline" | "words" {
  if (typeof text !== "string") return "words";
  if (
    /\?|\b(need|needs) more (information|details|context)\b|\bcould you\b|\bplease (provide|specify|tell|clarify|let me know)\b|\bwhich (field|column)s?\b/i.test(
      text,
    )
  )
    return "question";
  return /\b(can only|can't|cannot|can not|unable to|not able to|only answer|only help|outside|not possible|isn't possible|is not possible)\b/i.test(
    text,
  )
    ? "decline"
    : "words";
}

/** Formula JSON belongs in the formula column, not in the explanation. */
export function prepReplyWithoutJson(text: unknown): unknown {
  if (typeof text !== "string") return text;
  let stripped = text.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/g, "");
  if (stripped === text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const json = extractJsonObject(text);
    if (json && "calc" in object(JSON.parse(json)))
      stripped = text.slice(0, start) + text.slice(end + 1);
  }
  return stripped.replace(/\n{3,}/g, "\n\n").trim() || text;
}

export function prepIntentLabel(text: unknown): string {
  return normalizeIntent(
    typeof text === "string"
      ? text
          .trim()
          .replace(/^result\s*:\s*/i, "")
          .split(/\r?\n/)[0]
      : text,
  );
}

function rowFor(kind: SuiteKind, c: PrepCase): RowPayload {
  const rec = c.record;
  return {
    test_case_id: c.caseId,
    runner: `prep-${kind}`,
    datasource: dataName(rec),
    utterance: rec.canonical,
    turn: Array.isArray(rec.history) ? rec.history.length : 0,
    expected: expectedDict(kind, rec),
    actual: {},
    latency: null,
    errors: [],
    metrics: {},
    debug_info: rec.history ? { conversation: rec.history } : {},
    info: Object.fromEntries(
      ["description", "test-file"].filter((k) => rec[k]).map((k) => [k, rec[k]]),
    ),
  };
}

/** Read the server answer, then apply the bench's deterministic scoring rules. */
export function scorePrepServerRow(
  kind: SuiteKind,
  rec: PrepRecord,
  row: RowPayload,
  body: Record<string, unknown>,
): void {
  const text = object(body.response).content ?? null;
  const result = object(object(body.intentApplicationDetection).result);
  if (kind === "calc-gen") {
    const calc = object(result.calculatedFieldFormula);
    const formula = calc.formula || result.calc || null;
    row.actual = {
      calculation: formula,
      user_friendly_reply: prepReplyWithoutJson(text),
      ...(calc.caption ? { caption: calc.caption } : {}),
    };
    const expected = typeof rec["expected-calc"] === "string" ? rec["expected-calc"].trim() : "";
    const actual = typeof formula === "string" ? formula.trim() : "";
    const validity = {
      metric_id: "PrepCalcGrammar",
      metric_name: "calcValidity",
      score: 0,
      explanation: "",
    };
    if (!expected) {
      validity.score = actual ? 0 : 1;
      validity.explanation = actual
        ? "The request called for no formula, but the model wrote one."
        : "The request called for no formula and the model wrote none.";
      row.metrics.calculatedFieldFormula = [validity];
      return;
    }
    if (!actual) {
      validity.explanation =
        {
          question: "The model asked a question",
          decline: "The model declined the request",
          words: "The model replied in words",
        }[prepReplyKind(text)] + " instead of writing a formula, so there is no formula to check.";
      row.metrics.calculatedFieldFormula = [
        validity,
        {
          metric_id: "PrepCalcSimilarity",
          metric_name: "levenshteinSimilarity",
          score: 0,
          explanation: "The model wrote no formula.",
        },
      ];
      return;
    }
    const problems = checkCalc(actual, parseFieldMetadata(rec["field-metadata"]));
    validity.score = problems.length ? 0 : 1;
    validity.explanation = problems.length ? problems.join("; ") : "Valid Tableau Prep formula.";
    const [score, explanation] = bestFormulaSimilarity(expected, rec["acceptable-calcs"], actual);
    row.metrics.calculatedFieldFormula = [
      validity,
      { metric_id: "PrepCalcSimilarity", metric_name: "levenshteinSimilarity", score, explanation },
    ];
  } else if (kind === "intent-gen") {
    const label = prepIntentLabel(text);
    const expected = prepIntentLabel(rec["expected-intent"]);
    const valid = ["calc", "flow-plan", "other"].includes(label);
    row.actual = {
      intent: valid ? label : "",
      ...(!valid ? { raw_reply: String(text || "").slice(0, 300) } : {}),
    };
    const score = intentScore(label, expected, rec["plausible-intents"]);
    row.metrics.intent = [
      {
        metric_id: "PrepIntentMatch",
        metric_name: "equals",
        score,
        explanation: intentExplanation(Boolean(label), expected, label, score),
      },
    ];
  } else {
    const parsed = typeof text === "string" ? extractJsonObject(text) : null;
    const plan = typeof text === "object" ? text : parsed ? JSON.parse(parsed) : null;
    row.actual = plan
      ? { flowPlan: plan }
      : { raw_reply: String(text || "").slice(0, 300), no_plan: prepReplyKind(text) };
    if (!plan)
      row.errors.push({
        phase: "flow_plan",
        description: {
          question:
            "The model asked a question instead of planning the flow, so the case scores zero.",
          decline:
            "The model declined the request instead of planning the flow, so the case scores zero.",
          words:
            "The model answered in words, not with the plan the feature expects, so the case scores zero.",
        }[prepReplyKind(text)],
        warning: true,
      });
    if (isStepList(rec["expected-flow-plan"]))
      row.metrics.flowPlan = flowPlanMetrics(rec["expected-flow-plan"], planStepNames(plan), rec["acceptable-flow-plans"]);
  }
}

export class PrepServerAdapter implements EvalAdapter {
  readonly id = "prep_server";

  session(_config: RunConfig, _jobId: string): AdapterSession {
    return { close() {} };
  }

  load(config: RunConfig): SuitePlan {
    const root = prepRoot(config);
    const { dir, kind } = resolveSuite(config, root);
    const cases = flattenSuite(dir, kind, undefined, true);
    if (!cases.length) throw new Error("No runnable Tableau Prep cases found");
    if (kind === "flow-plan-gen") {
      for (const c of cases) {
        const location = c.record["data-location"];
        const path = location ? (isAbsolute(location) ? location : join(root, location)) : null;
        c.record.user_data = path && contentExists(path) ? contentReadText(path) : null;
      }
    }
    return {
      total: cases.length,
      skeletons: cases.map((c) => rowFor(kind, c)),
      conversation_ids: cases.map((c) => [c.caseId]),
      opaque: { kind, cases },
    };
  }
  async execute(
    plan: SuitePlan,
    config: RunConfig,
    emit: EmitCase,
    stop: ShouldStop,
    completed: Set<string>,
  ): Promise<void> {
    const { kind, cases } = plan.opaque as { kind: SuiteKind; cases: PrepCase[] };
    let base = String(config.ces_url || "")
      .trim()
      .replace(/\/+$/, "");
    if (base.endsWith("/content-exploration")) base = base.slice(0, -"/content-exploration".length);
    base =
      base ||
      String(config.tableau_server || "")
        .trim()
        .replace(/\/+$/, "");
    if (!base) throw new Error("The Tableau Prep suites need a Tableau Server connection");
    const session = sessionFor(config, String(config.job_id || ""));
    const rpm = resolveRequestsPerMinute(config);
    const deps = {
      fetchImpl: fetch,
      sleep: (ms: number) => Bun.sleep(ms),
      limiter: new RateLimiter({ rate: rpm ? Math.max(1, rpm / 6) : 2, windowMs: 10000 }),
      tls: tlsInit({
        verify: config.verify_tls !== false,
        caBundlePath: config.ca_bundle_path as string | undefined,
      }),
    };
    let next = 0;
    const worker = async () => {
      while (next < cases.length && !stop()) {
        const c = cases[next++];
        if (completed.has(c.caseId)) continue;
        plan.case_started?.(c.caseId);
        const row = rowFor(kind, c);
        if (kind === "flow-plan-gen" && !c.record.user_data)
          row.errors.push({
            phase: "load",
            description: `The case's sample data file (${c.record["data-location"]}) is not in the bench folder.`,
            warning: false,
          });
        else {
          try {
            const [status, body, seconds] = await postPalette(
              `${base}/content-exploration/analytics-assistant/conversations`,
              prepServerRequest(kind, c.record),
              session,
              deps,
              HEADERS,
              config._run_signal as AbortSignal | undefined,
            );
            if (status !== 200 || !body || typeof body !== "object")
              row.errors.push({
                phase: "request",
                description: `Tableau Server answered the Tableau Prep request with HTTP ${status}: ${body}.`,
                warning: false,
              });
            else {
              row.latency = seconds;
              scorePrepServerRow(kind, c.record, row, object(body));
            }
          } catch (e) {
            row.errors.push({
              phase: "request",
              description: e instanceof Error ? e.message : String(e),
              warning: false,
            });
          }
        }
        await emit(row);
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: resolveMaxConcurrency(config) }, worker),
    );
    for (const r of results) if (r.status === "rejected") throw r.reason;
  }
}
register(new PrepServerAdapter());
