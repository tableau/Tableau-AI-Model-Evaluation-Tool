/**
 * Colour-palette LLM-judge metrics for the tool's BYOK judge.
 *
 * Palette judge request and scoring logic.
 *
 * To avoid the site's model judging its own palettes, the judge uses a different
 * model family, configured only in the tool's settings. The tool runs palette
 * suites with `byollm_palette_metrics` (the deterministic checks only) and
 * scores this rubric here, with the judge configured in Settings, into the
 * judge stage with the judge identity stamped on the run.
 *
 * The two templates below use triple-brace placeholders with no
 * escaping). The judge answers `{"valid": bool, "relevance": 0-1, "design":
 * 0-1, "<metric>Reasoning": str}`; `valid` becomes 1.0/0.0.
 * A judge failure yields `score=null` ("Unavailable",
 * excluded from averages) per metric.
 *
 * Reuses the shared retry/provider machinery (`callJudge`);
 * the response is the raw judge text, parsed here.
 */

import {
  callJudge,
  DEFAULT_RETRY_POLICY,
  JUDGE_STAGE,
  type ComputedMetric,
  type FetchFn,
  type JudgeConfig,
  type RetryPolicy,
} from "./judge.ts";

/** Stage the palette rubric is written under — the shared judge stage. */
export { JUDGE_STAGE as PALETTE_STAGE };

/** The metric_id stamped on every palette-judge entry. */
export const PALETTE_JUDGE_METRIC_ID = "PaletteJudge";

/** The three LLM-scored palette dimensions. */
export const PALETTE_JUDGE_METRIC_NAMES = ["valid", "relevance", "design"] as const;

/** Palette scoring can be slower than a short NL reply — 60s default. */
export const DEFAULT_PALETTE_TIMEOUT_S = 60.0;

// The evaluator's color-palette-judge prompts, inlined verbatim
// (evaluation-prompts/color-palette-judge/{system,user}-prompt.mustache).
const SYSTEM_PROMPT =
  "You are an expert at evaluating color palettes for data visualization and design applications. You have deep knowledge of:\n\n" +
  "- Color theory and color harmony principles\n" +
  "- Accessibility guidelines for color usage (WCAG standards)\n" +
  "- Data visualization best practices for color selection\n" +
  "- Different palette types (sequential, diverging, or regular)\n" +
  "- Color format validation (hex codes, RGB, HSL, etc.)\n" +
  "- Brand and aesthetic considerations for color palettes\n\n" +
  "Your task is to evaluate whether a generated color palette is:\n" +
  "1. Valid: Contains properly formatted color values (e.g., valid hex codes)\n" +
  "2. Relevant: Appropriate for the given prompt and palette type\n" +
  "3. Well-designed: Follows good color theory principles and is suitable for data visualization\n\n" +
  "Palette types:\n" +
  "- regular: Colors that are visually distinct from each other, used to represent different categories or groups. These should have good contrast and be easily distinguishable.\n" +
  "- sequential: Colors that progress in a logical sequence, typically used to represent ordered data or series of numbers. These usually create a smooth visual progression.\n" +
  "- diverging: Colors that diverge from a central neutral color to two distinct extremes, typically used to represent data with a meaningful center point. These usually have a clear midpoint and contrasting endpoints.\n\n" +
  "You will be provided with:\n" +
  "- The user's original utterance\n" +
  '- The requested palette type (e.g., "regular", "sequential", "diverging")\n' +
  "- The generated color palette response\n\n" +
  'You MUST respond with ONLY a JSON object, with no additional text before or after it. The format must be: { "valid": boolean, "relevance": number, "design": number, "validReasoning": string, "relevanceReasoning": string, "designReasoning": string }\n\n' +
  '- "valid" should be true if the palette is valid, meaning it contains properly formatted hex codes\n' +
  '- "relevance" should be a float between 0 and 1 scoring how relevant the palette is to the utterance\n' +
  '- "design" should be a float between 0 and 1 scoring how well the palette follows good color theory principles and how suitable it is for data visualization\n' +
  '- "<metric>Reasoning" should explain your evaluation criteria and reasoning for the metric "<metric>"\n\n' +
  "Your response must be ONLY the JSON object, with no introductory text, explanations, or other content outside the JSON.\n";

const USER_PROMPT_TEMPLATE =
  "Given the user utterance and palette type, evaluate whether the generated color palette is valid, relevant, and well-designed.\n\n" +
  "User Utterance: `{{{utterance}}}`\n\n" +
  "Requested Palette Type: `{{{palette_type}}}`\n\n" +
  "Generated Color Palette Response:\n{{{actual}}}\n\n" +
  "Evaluation Criteria:\n\n" +
  "1. Validity (Technical):\n" +
  "   - Are all color values properly formatted (e.g., valid hex codes like #FF0000)?\n" +
  "   - Are there any malformed or invalid color values?\n" +
  "   - Is the palette structure correct for the requested type?\n\n" +
  "2. Relevance:\n" +
  "   - Does the palette match the user's request and intent?\n\n" +
  "3. Design Quality:\n" +
  "   - For regular palettes: Are colors distinct enough to differentiate categories?\n" +
  "   - For sequential palettes: Is there a clear progression from light to dark (or vice versa)?\n" +
  "   - For diverging palettes: Is there a clear neutral center with contrasting extremes?\n" +
  "   - Are colors accessible and readable?\n" +
  "   - Do colors follow good color theory principles?\n\n" +
  "Evaluate the generated palette against these criteria and provide your reasoning.\n\n" +
  "Respond with ONLY a JSON object. Do not include any text before or after the JSON object. Do not use markdown code blocks. Return only the raw JSON.\n";

/**
 * System prompt, then the user prompt with its three placeholders filled — the
 * same flattening the evaluator's chat→prompt path does.
 */
export function buildPaletteJudgePrompt(
  utterance: string,
  paletteType: string | null | undefined,
  palette: unknown,
): string {
  let paletteStr: string;
  if (typeof palette === "string") {
    paletteStr = palette;
  } else {
    try {
      paletteStr = JSON.stringify(palette);
    } catch {
      paletteStr = String(palette);
    }
  }
  const user = USER_PROMPT_TEMPLATE.split("{{{utterance}}}")
    .join(utterance || "")
    .split("{{{palette_type}}}")
    .join(paletteType || "regular")
    .split("{{{actual}}}")
    .join(paletteStr || "[]");
  return `${SYSTEM_PROMPT}\n\n${user}`;
}

/** Clamp/normalize one judge value to a 0–1 score. */
function asScore(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1.0 : 0.0;
  const f = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(f)) return null;
  return Math.max(0.0, Math.min(1.0, f));
}

/**
 * (scores by metric name, reasoning by metric name) from the judge's reply;
 * both empty when nothing parseable came back.
 */
export function parsePaletteJudgeJson(text: string): {
  scores: Record<string, number | null>;
  reasons: Record<string, string>;
} {
  const empty = { scores: {} as Record<string, number | null>, reasons: {} as Record<string, string> };
  if (!text) return empty;
  const stripped = text.trim();
  const candidates: string[] = [];
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1]);
  candidates.push(stripped);
  const braces = stripped.match(/\{[\s\S]*\}/);
  if (braces?.[0]) candidates.push(braces[0]);

  for (const cand of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(cand);
    } catch {
      continue;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const obj = data as Record<string, unknown>;
    const scores: Record<string, number | null> = {};
    const reasons: Record<string, string> = {};
    for (const name of PALETTE_JUDGE_METRIC_NAMES) {
      if (name in obj) scores[name] = asScore(obj[name]);
      const r = obj[`${name}Reasoning`];
      if (typeof r === "string" && r.trim()) reasons[name] = r.trim();
    }
    if (Object.keys(scores).length > 0) return { scores, reasons };
  }
  return empty;
}

function entry(name: string, score: number | null, explanation: string | null): ComputedMetric {
  return {
    metric_id: PALETTE_JUDGE_METRIC_ID,
    metric_name: name,
    score,
    explanation,
  };
}

/** Every dimension "Unavailable: <reason>". */
function unavailable(reason: string): ComputedMetric[] {
  const msg = `Unavailable: ${reason}`.slice(0, 200);
  return PALETTE_JUDGE_METRIC_NAMES.map((name) => entry(name, null, msg));
}

/**
 * Score one palette case with the BYOK judge. Never throws: judge failures produce
 * score=null ("Unavailable") entries per metric. Returns [] when the judge is
 * not configured (not requested) so the three scores are simply absent.
 */
export async function computePaletteJudgeMetrics(
  args: {
    utterance: string;
    paletteType: string | null | undefined;
    palette: unknown;
    judgeCfg: JudgeConfig | null | undefined;
    timeoutS?: number;
  },
  opts: { fetchFn?: FetchFn; retry?: RetryPolicy } = {},
): Promise<ComputedMetric[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const retry = opts.retry ?? DEFAULT_RETRY_POLICY;
  const cfg = args.judgeCfg ?? {};
  const provider = cfg.provider ?? "";
  const apiKey = cfg.api_key ?? "";
  if (!provider || !apiKey) return [];
  if (!args.palette || (Array.isArray(args.palette) && args.palette.length === 0)) {
    return unavailable("no palette to score");
  }

  let text: string;
  try {
    text = await callJudge({
      provider,
      model: cfg.model || "",
      apiKey,
      prompt: buildPaletteJudgePrompt(args.utterance, args.paletteType, args.palette),
      timeoutS: args.timeoutS ?? cfg.timeout_s ?? DEFAULT_PALETTE_TIMEOUT_S,
      fetchFn,
      retry,
    });
  } catch (exc) {
    return unavailable(String(exc instanceof Error ? exc.message : exc));
  }

  const { scores, reasons } = parsePaletteJudgeJson(text);
  if (Object.keys(scores).length === 0) {
    return unavailable(`unparseable judge response: ${text.slice(0, 120)}`);
  }
  return PALETTE_JUDGE_METRIC_NAMES.map((name) =>
    entry(name, scores[name] ?? null, reasons[name] ?? null),
  );
}
