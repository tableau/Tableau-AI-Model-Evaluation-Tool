/**
 * An intent answer as the bare class label: whitespace, quotes, backticks and
 * a trailing period around it are dropped, the case is lowered, and
 * "flow plan" / "flow_plan" read as flow-plan.
 */
export function normalizeIntent(text: unknown): string {
  if (typeof text !== "string") return "";
  let t = text.trim();
  t = t.replace(/^[`'"\s]+|[`'"\s.]+$/g, "");
  return t.toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * The score of an answer that is not the expected kind but is listed in the
 * case's `plausible-intents`: another fair reading of an ambiguous request.
 */
export const PLAUSIBLE_CREDIT = 0.5;

/** 1 for the expected kind, PLAUSIBLE_CREDIT for a kind the case lists as plausible, else 0. Both labels already normalized. */
export function intentScore(detected: string, expected: string, plausible: unknown): number {
  if (detected && detected === expected) return 1;
  const kinds = Array.isArray(plausible) ? plausible.map(normalizeIntent) : [];
  if (detected && kinds.includes(detected)) return PLAUSIBLE_CREDIT;
  return 0;
}

/** The Intent Match explanation, shared by every path that scores an intent case. */
export function intentExplanation(answered: boolean, expected: string, detected: string, value: number): string {
  if (!answered) return "The model answered nothing.";
  if (value >= 1) return `Matches: ${expected}.`;
  if (value > 0)
    return `Expected ${expected}, the model said ${detected}: also a plausible reading of the request, so it earns partial credit.`;
  return `Expected ${expected}, the model said ${detected}.`;
}
