/**
 * API base URL for all backend requests.
 * Defaults to the current origin (works in production when the frontend is served
 * by the tool). Override with REACT_APP_API_BASE_URL for cross-origin setups.
 */
export const API_BASE =
  process.env.REACT_APP_API_BASE_URL || window.location.origin;

/** A model provider and its available model IDs, returned by GET /get-models. */
export interface ModelProvider {
  provider: string;
  models: string[];
}

// ---------------------------------------------------------------------------
// NLQ Evaluator (BYOLLM) API functions
// ---------------------------------------------------------------------------

/**
 * Fetch the current status of an NLQ eval job.
 * Used by useNlqEvalStream to decide between streaming and static loading.
 * @returns Object with status, total, completed, org_id, user_id fields.
 */
export const fetchNlqEvalStatus = async (jobId: string, signal?: AbortSignal) => {
  const res = await fetch(`${API_BASE}/nlq-eval/status/${jobId}`, { signal });
  return res.json();
};

/**
 * Fetch the complete results for a finished NLQ eval job from SQLite.
 * @returns NlqEvalFullResults containing run metadata, test results, metrics, and errors.
 * @throws Error if the HTTP response is not OK (e.g. job not found).
 */
export const fetchNlqEvalResults = async (jobId: string, signal?: AbortSignal) => {
  const res = await fetch(`${API_BASE}/nlq-eval/results/${jobId}`, { signal });
  if (!res.ok) throw new Error(`Failed to fetch results: ${res.status}`);
  return res.json();
};

/**
 * Build the SSE stream URL for a running NLQ eval job.
 * Returns a plain URL string (not a fetch call) because the caller
 * manages the ReadableStream directly via fetch + AbortController.
 */
export const nlqEvalEventsUrl = (jobId: string) =>
  `${API_BASE}/nlq-eval/events/${jobId}`;

/**
 * Cancel a running NLQ eval job.
 * Sends a POST to abort the RQ worker and emit a "done" SSE event.
 */
export const cancelNlqEvalJob = async (jobId: string) => {
  const res = await fetch(`${API_BASE}/nlq-eval/cancel/${jobId}`, { method: "POST" });
  return res.json();
};

export const fetchModels = async (): Promise<ModelProvider[]> => {
  try {
    const response = await fetch(`${API_BASE}/get-models`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch models:', error);
    // Return fallback models if API fails
    return [
      {
        provider: "OpenAI",
        models: ["openai-gpt-5", "openai-gpt-5-mini", "openai-gpt-5-nano", "openai-gpt-4o", "openai-gpt-4.1", "openai-o3", "openai-o4-mini"]
      },
      {
        provider: "Salesforce", 
        models: ["anthropic-claude-3.7-sonnet", "deepseek-r1"] // "SFR-Tableau-Finetuned"
      }
    ];
  }
};