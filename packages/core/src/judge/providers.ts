/**
 * Provider-native request builders for the BYOK judge.
 *
 * The admin brings an
 * OpenAI, Anthropic, or Gemini API key, configured only in the tool, and the
 * judge is the ONLY LLM the tool calls directly — no EGPT wire format, no
 * corporate-gateway hop. These builders produce the provider-native HTTP
 * request for a single scoring prompt and parse the reply text back out.
 *
 * Pure build/parse functions (no I/O) so the async judge (fetch) and any
 * caller share one wire-format definition, and tests can assert exact
 * request shapes without a network.
 */

/**
 * The three providers the Jul 29 review scoped for 264. Extending this set is
 * a product decision, not a code convenience.
 */
export const PROVIDERS = ["openai", "anthropic", "gemini"] as const;

export type Provider = (typeof PROVIDERS)[number];

export interface ChatMessage {
  role: string;
  content: string;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Model-name → family detection, used for the judge≠model-under-test check
 * (a model must not judge its own family).
 */
const _FAMILY_MARKERS: Record<string, readonly string[]> = {
  anthropic: ["claude", "anthropic"],
  gemini: ["gemini", "google"],
  mistral: ["mistral", "codestral", "mixtral"],
  llama: ["llama", "meta-llama"],
  openai: ["gpt", "o1", "o3", "o4", "openai"],
};

/** Best-effort model-family detection from a model name; null if unknown. */
export function detectFamily(modelName: string): string | null {
  const lower = (modelName || "").toLowerCase();
  if (!lower) {
    return null;
  }
  for (const [family, markers] of Object.entries(_FAMILY_MARKERS)) {
    if (markers.some((m) => lower.includes(m))) {
      return family;
    }
  }
  return null;
}

const _OPENAI_REASONING_MODEL = /^(gpt-(?:[5-9]|\d{2,})|o\d)/;

/** True for the OpenAI models that reject `max_tokens`/`temperature`. */
function openaiReasoningModel(model: string): boolean {
  return _OPENAI_REASONING_MODEL.test((model || "").toLowerCase());
}

const _ANTHROPIC_FIXED_TEMPERATURE = /^claude-(?:opus|sonnet|haiku)-(?:[5-9]|\d{2,})/;

/** True for the Claude models that reject a `temperature` parameter. */
function anthropicFixedTemperature(model: string): boolean {
  return _ANTHROPIC_FIXED_TEMPERATURE.test((model || "").toLowerCase());
}

/** Return { url, headers, query, body } for one chat call. */
export function buildRequest(
  provider: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  maxTokens = 400,
  temperature = 0.0,
): BuiltRequest {
  if (provider === "openai") {
    const body: Record<string, unknown> = { model, messages };
    // OpenAI's reasoning models (GPT-5 onwards, GPT-6 named builds such as
    // gpt-6-luna, and the o-series) take max_completion_tokens and only
    // support the default temperature; gpt-4.x still take the old pair.
    if (openaiReasoningModel(model)) {
      body.max_completion_tokens = Math.max(maxTokens, 4000);
    } else {
      body.max_tokens = maxTokens;
      body.temperature = temperature;
    }
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      query: {},
      body,
    };
  }

  if (provider === "anthropic") {
    // Anthropic takes system prompts as a top-level parameter.
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: chatMessages,
    };
    // Claude 5 and later reject temperature ("deprecated for this
    // model"); Claude 4.x still take it.
    if (!anthropicFixedTemperature(model)) {
      body.temperature = temperature;
    }
    if (systemParts.length > 0) {
      body.system = systemParts.join("\n\n");
    }
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      query: {},
      body,
    };
  }

  if (provider === "gemini") {
    // Gemini: 'user'/'model' roles and a systemInstruction field.
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    };
    if (systemParts.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemParts.join("\n\n") }],
      };
    }
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { "Content-Type": "application/json" },
      query: { key: apiKey },
      body,
    };
  }

  throw new Error(
    `Unsupported judge provider: ${JSON.stringify(provider)} (expected one of ${PROVIDERS.join(", ")})`,
  );
}

/** Extract the assistant text from a provider response; '' when absent. */
export function parseResponse(provider: string, data: unknown): string {
  try {
    if (provider === "openai") {
      const d = data as { choices: { message: { content?: string | null } }[] };
      return d.choices[0].message.content || "";
    }
    if (provider === "anthropic") {
      const d = data as { content?: ({ type?: string; text?: string | null } | null)[] };
      return (d.content ?? [])
        .filter((block) => block?.type === "text")
        .map((block) => block?.text ?? "")
        .join("");
    }
    if (provider === "gemini") {
      const d = data as { candidates?: ({ content?: { parts?: ({ text?: string | null } | null)[] } } | null)[] };
      const candidates = d.candidates ?? [];
      if (!candidates.length) {
        return "";
      }
      const parts = candidates[0]?.content?.parts ?? [];
      return parts.map((p) => p?.text ?? "").join("");
    }
  } catch {
    // KeyError / IndexError / TypeError equivalents → treat as absent.
    return "";
  }
  throw new Error(`Unsupported judge provider: ${JSON.stringify(provider)}`);
}
