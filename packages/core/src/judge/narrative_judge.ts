/** Dashboard Narratives BYOK judge; prompts and scoring are pinned by fixtures. */
import {
  callJudge,
  DEFAULT_RETRY_POLICY,
  type ComputedMetric,
  type FetchFn,
  type JudgeConfig,
  type RetryPolicy,
} from "./judge.ts";
import { FACTUALITY_PROMPT, SIMILARITY_PROMPT } from "./narrative_prompts.ts";

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface NarrativeTruths {
  outliers: Array<{ view: string; items?: Obj[]; raw?: string }>;
  insights: Array<{ view: string; text: string }>;
}

export const NARRATIVE_JUDGE_METRIC_NAMES = [
  "llmIsSimilar",
  "Semantic Factuality Precision Rate",
  "Semantic Factuality Recall Rate",
] as const;
const NO_TRUTHS = "There are no outliers or pulse insights in the dashboard.";
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function loads(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Keep only the artifact fields the judge's rubric reads. */
export function narrativeGroundTruths(views: unknown): NarrativeTruths {
  const out: NarrativeTruths = { outliers: [], insights: [] };
  for (const view of list(views).map(object))
    for (const artifact of list(view.artifacts).map(object)) {
      const name = String(view.name || "");
      const raw = artifact.artifact;
      const items = loads(raw);
      if (artifact.artifactType === "OUTLIERS") {
        if (Array.isArray(items)) {
          const kept = items
            .filter((v) => v && typeof v === "object" && !Array.isArray(v))
            .map(object)
            .map((it) => ({
              caption: it.caption ?? it.dimensions ?? "",
              columnCaption: it.columnCaption ?? it.measureCaption ?? "",
              formattedValue: it.formattedValue ?? "",
              isHigh:
                it.isHigh === true ||
                (typeof it.isHigh === "string" && it.isHigh.trim().toLowerCase() === "true"),
            }));
          if (kept.length) out.outliers.push({ view: name, items: kept });
        } else if (typeof raw === "string" && raw.trim()) out.outliers.push({ view: name, raw });
      } else if (artifact.artifactType === "PULSE_INSIGHTS") {
        if (Array.isArray(items))
          for (const it of items.map(object)) {
            const text = it.insight || it.markup;
            if (text) out.insights.push({ view: name, text: String(text) });
          }
        else if (typeof raw === "string" && raw.trim())
          out.insights.push({ view: name, text: raw });
      }
    }
  return out;
}

/** Read section bodies from JSON summaries, or a plain-text summary as-is. */
export function narrativeText(summary: unknown): string {
  let doc = summary;
  if (typeof summary === "string") {
    try {
      doc = JSON.parse(summary);
    } catch {
      return summary.replace(/\n/g, " ").trim();
    }
  }
  const bodies: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else
      for (const [key, value] of Object.entries(object(node))) {
        if (key === "body" && typeof value === "string") bodies.push(value);
        walk(value);
      }
  };
  walk(doc);
  return (bodies.length ? bodies.join(" ") : typeof doc === "string" ? doc : "")
    .replace(/\n/g, " ")
    .trim();
}

function jsonObject(text: string): Obj | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  try {
    const v = JSON.parse(stripped);
    return v && !Array.isArray(v) && typeof v === "object" ? v : null;
  } catch {
    /* surrounding prose */
  }
  for (let start = stripped.indexOf("{"); start >= 0; start = stripped.indexOf("{", start + 1)) {
    let depth = 0;
    for (let i = start; i < stripped.length; i++) {
      if (stripped[i] === "{") depth++;
      if (stripped[i] === "}" && --depth === 0) {
        try {
          return object(JSON.parse(stripped.slice(start, i + 1)));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/** New 0–10 grades and older yes/no scores share the same 0–1 storage. */
export function parseNarrativeSimilarity(text: string): [number | null, string | null] {
  const obj = jsonObject(text);
  if (!obj) return [null, null];
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  const graded = lower.llmissimilarscore;
  const verdict = lower.llmissimilar;
  let score: number;
  if (graded != null) {
    const value = Number(String(graded).trim().replace(/%$/, ""));
    if (!Number.isFinite(value)) return [null, null];
    score = round4(Math.max(0, Math.min(1, value / 10)));
  } else if (typeof verdict === "boolean") score = verdict ? 1 : 0;
  else if (typeof verdict === "number") score = Math.max(0, Math.min(1, verdict));
  else if (typeof verdict === "string" && /^(true|false|yes|no)$/i.test(verdict.trim()))
    score = /^(true|yes)$/i.test(verdict.trim()) ? 1 : 0;
  else return [null, null];
  const reason = lower.llmissimilarreasoning;
  return [score, typeof reason === "string" ? reason.trim() || null : null];
}

export function parseNarrativeFactuality(text: string): [number, number, string[]] | null {
  const obj = jsonObject(text);
  if (!obj || Object.keys(obj).length === 0) return null;
  const total = Number(obj.total_truths || 0);
  const accurate = Number(obj.semantically_accurate_truths || 0);
  if (!Number.isFinite(total) || !Number.isFinite(accurate)) return null;
  return [
    Math.max(0, Math.trunc(total)),
    Math.max(0, Math.trunc(accurate)),
    list(obj.misrepresented_narratives).map((m) => (typeof m === "string" ? m : JSON.stringify(m))),
  ];
}

/** Preserve the evaluator's denominators: precision over mentioned truths,
 * recall over truths that were not misrepresented. No mention is not a lie. */
export function narrativeFactualityScores(
  total: number,
  accurate: number,
  misrepresented: string[],
): [number, number, string, string] {
  const bad = misrepresented.length;
  const mentioned = accurate + bad;
  const noMistakes = total - bad;
  const precision = total === 0 || mentioned === 0 ? 1 : round4(accurate / mentioned);
  const recall =
    total === 0 ? 1 : noMistakes <= 0 ? 0 : round4(Math.min(accurate, noMistakes) / noMistakes);
  let details = `Total truths: ${total}\nTotal Semantically Accurate Truths: ${accurate}\nMisrepresented narratives: ${bad}\n`;
  if (bad)
    details += `Misrepresented Narratives:\n${misrepresented.map((m, i) => `${i + 1}. ${m}\n`).join("")}`;
  const precisionText =
    total === 0
      ? NO_TRUTHS
      : mentioned === 0
        ? `The summary describes none of the ${total} detected outliers and insights, so there is nothing described wrongly.\n${details}`
        : details;
  const recallText =
    total === 0
      ? NO_TRUTHS
      : mentioned === 0
        ? `The summary describes none of the ${total} detected outliers and insights.`
        : `${accurate} of the ${total} detected outliers and insights are described, and described the right way round${bad ? `; ${bad} described the wrong way round` : ""}.`;
  return [precision, recall, precisionText, recallText];
}

function entry(name: string, score: number | null, explanation: string | null): ComputedMetric {
  return { metric_id: "NarrativeJudge", metric_name: name, score, explanation };
}

/** Never lose an answer to a judge failure: emit Unavailable scores instead.
 * Similarity needs a reference; factuality needs no call when truths are empty. */
export async function computeNarrativeJudgeMetrics(
  args: {
    expectedNarrative: unknown;
    actualNarrative: unknown;
    truths?: NarrativeTruths | null;
    judgeCfg?: JudgeConfig | null;
  },
  opts: { fetchFn?: FetchFn; retry?: RetryPolicy } = {},
): Promise<ComputedMetric[]> {
  const cfg = args.judgeCfg;
  if (!cfg?.provider || !cfg.api_key) return [];
  const text = narrativeText(args.actualNarrative);
  if (!text) return [];
  const call = (prompt: string) =>
    callJudge({
      provider: cfg.provider!,
      apiKey: cfg.api_key!,
      model: cfg.model || "",
      prompt,
      timeoutS: cfg.timeout_s || 60,
      fetchFn: opts.fetchFn || fetch,
      retry: opts.retry || DEFAULT_RETRY_POLICY,
    });
  const unavailable = (names: readonly string[], reason: string) =>
    names.map((n) => entry(n, null, `Unavailable: ${reason}`.slice(0, 200)));
  const out: ComputedMetric[] = [];
  if (typeof args.expectedNarrative === "string" && args.expectedNarrative.trim()) {
    try {
      const [score, reason] = parseNarrativeSimilarity(
        await call(
          SIMILARITY_PROMPT.replace("{expected}", args.expectedNarrative.trim()).replace(
            "{actual}",
            text,
          ),
        ),
      );
      out.push(
        entry(
          NARRATIVE_JUDGE_METRIC_NAMES[0],
          score,
          score === null
            ? "Unavailable: the evaluator model's answer was not the expected JSON"
            : reason,
        ),
      );
    } catch (e) {
      out.push(
        ...unavailable(
          [NARRATIVE_JUDGE_METRIC_NAMES[0]],
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  }
  const truths = args.truths || { outliers: [], insights: [] };
  const count =
    truths.outliers.reduce((n, e) => n + (e.items ? e.items.length : 1), 0) +
    truths.insights.length;
  if (!count)
    return [
      ...out,
      entry(NARRATIVE_JUDGE_METRIC_NAMES[1], 1, NO_TRUTHS),
      entry(NARRATIVE_JUDGE_METRIC_NAMES[2], 1, NO_TRUTHS),
    ];
  const outliers = truths.outliers
    .map(
      (e) =>
        `- View name: ${e.view}; Artifact: ${e.items ? JSON.stringify(e.items) : e.raw || ""}\n`,
    )
    .join("");
  const insights = truths.insights
    .map((e) => `- View name: ${e.view}; Pulse Insights: ${e.text}\n`)
    .join("");
  try {
    const parsed = parseNarrativeFactuality(
      await call(
        FACTUALITY_PROMPT.replace("{artifact_ground_truths}", outliers)
          .replace("{pulse_insights_ground_truths}", insights)
          .replace("{narrative}", text),
      ),
    );
    if (!parsed)
      out.push(
        ...unavailable(
          NARRATIVE_JUDGE_METRIC_NAMES.slice(1),
          "the evaluator model's answer was not the expected JSON",
        ),
      );
    else {
      const [p, r, pt, rt] = narrativeFactualityScores(...parsed);
      out.push(
        entry(NARRATIVE_JUDGE_METRIC_NAMES[1], p, pt),
        entry(NARRATIVE_JUDGE_METRIC_NAMES[2], r, rt),
      );
    }
  } catch (e) {
    out.push(
      ...unavailable(
        NARRATIVE_JUDGE_METRIC_NAMES.slice(1),
        e instanceof Error ? e.message : String(e),
      ),
    );
  }
  return out;
}
