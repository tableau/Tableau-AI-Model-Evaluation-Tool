import { test, expect, describe } from "bun:test";
import {
  PROVIDERS,
  detectFamily,
  buildRequest,
  parseResponse,
  type ChatMessage,
} from "./providers.ts";

const SYSTEM_AND_USER: ChatMessage[] = [
  { role: "system", content: "sys-a" },
  { role: "user", content: "hello" },
];

describe("PROVIDERS", () => {
  test("scoped to the three Jul-29 providers", () => {
    expect(PROVIDERS).toEqual(["openai", "anthropic", "gemini"]);
  });
});

describe("detectFamily", () => {
  test("openai markers", () => {
    expect(detectFamily("gpt-4o")).toBe("openai");
    expect(detectFamily("o1-preview")).toBe("openai");
    expect(detectFamily("o3-mini")).toBe("openai");
    expect(detectFamily("o4")).toBe("openai");
    expect(detectFamily("OpenAI-Custom")).toBe("openai");
  });

  test("anthropic markers", () => {
    expect(detectFamily("claude-3-5-sonnet")).toBe("anthropic");
    expect(detectFamily("anthropic-x")).toBe("anthropic");
  });

  test("gemini markers", () => {
    expect(detectFamily("gemini-1.5-pro")).toBe("gemini");
    expect(detectFamily("google-model")).toBe("gemini");
  });

  test("mistral / llama markers", () => {
    expect(detectFamily("mistral-large")).toBe("mistral");
    expect(detectFamily("mixtral-8x7b")).toBe("mistral");
    expect(detectFamily("codestral")).toBe("mistral");
    expect(detectFamily("llama-3")).toBe("llama");
    expect(detectFamily("meta-llama/x")).toBe("llama");
  });

  test("unknown / empty → null", () => {
    expect(detectFamily("")).toBeNull();
    expect(detectFamily("some-random-model")).toBeNull();
    // @ts-expect-error - guarding null-ish input like the Python `model or ""`
    expect(detectFamily(null)).toBeNull();
  });

  test("case-insensitive", () => {
    expect(detectFamily("CLAUDE-3")).toBe("anthropic");
    expect(detectFamily("GPT-4O")).toBe("openai");
  });
});

describe("buildRequest — openai", () => {
  test("standard model uses max_tokens + temperature", () => {
    const req = buildRequest("openai", "gpt-4o", "sk-KEY", SYSTEM_AND_USER, 400, 0.0);
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers).toEqual({
      Authorization: "Bearer sk-KEY",
      "Content-Type": "application/json",
    });
    expect(req.query).toEqual({});
    expect(req.body).toEqual({
      model: "gpt-4o",
      messages: SYSTEM_AND_USER,
      max_tokens: 400,
      temperature: 0.0,
    });
    expect(req.body).not.toHaveProperty("max_completion_tokens");
  });

  test("gpt-5 branch: max_completion_tokens, no temperature, no max_tokens", () => {
    const req = buildRequest("openai", "gpt-5", "sk-KEY", SYSTEM_AND_USER, 400, 0.0);
    expect(req.body).toEqual({
      model: "gpt-5",
      messages: SYSTEM_AND_USER,
      max_completion_tokens: 4000,
    });
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body).not.toHaveProperty("max_tokens");
  });

  test("gpt-5 prefix match (e.g. gpt-5-turbo)", () => {
    const req = buildRequest("openai", "gpt-5-turbo", "sk-KEY", SYSTEM_AND_USER);
    expect(req.body).toHaveProperty("max_completion_tokens", 4000);
    expect(req.body).not.toHaveProperty("temperature");
  });

  test("gpt-6 named builds and the o-series use max_completion_tokens", () => {
    // gpt-6-luna rejected max_tokens with "Unsupported parameter" (2026-10-11).
    for (const model of ["gpt-6-luna", "gpt-6.1-sol", "o4-mini", "GPT-5"]) {
      const req = buildRequest("openai", model, "sk-x", SYSTEM_AND_USER, 400);
      expect(req.body).toHaveProperty("max_completion_tokens", 4000);
      expect(req.body).not.toHaveProperty("max_tokens");
      expect(req.body).not.toHaveProperty("temperature");
    }
    for (const model of ["gpt-4.1", "gpt-4o", "gpt-4o-mini"]) {
      const req = buildRequest("openai", model, "sk-x", SYSTEM_AND_USER, 400);
      expect(req.body).toHaveProperty("max_tokens", 400);
      expect(req.body).not.toHaveProperty("max_completion_tokens");
    }
  });

  test("custom max_tokens / temperature honored", () => {
    const req = buildRequest("openai", "gpt-4o", "k", SYSTEM_AND_USER, 128, 0.7);
    expect(req.body).toHaveProperty("max_tokens", 128);
    expect(req.body).toHaveProperty("temperature", 0.7);
  });
});

describe("buildRequest — anthropic", () => {
  test("extracts system as top-level param and strips from messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys-a" },
      { role: "system", content: "sys-b" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const req = buildRequest("anthropic", "claude-3-5-sonnet", "AKEY", messages, 400, 0.0);
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers).toEqual({
      "x-api-key": "AKEY",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    });
    expect(req.query).toEqual({});
    expect(req.body).toEqual({
      model: "claude-3-5-sonnet",
      max_tokens: 400,
      temperature: 0.0,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
      system: "sys-a\n\nsys-b",
    });
  });

  test("no system message → no system key", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const req = buildRequest("anthropic", "claude-3", "AKEY", messages);
    expect(req.body).not.toHaveProperty("system");
    expect(req.body).toHaveProperty("messages", [{ role: "user", content: "hi" }]);
  });

  test("Claude 5 and later omit temperature; Claude 4.x keep it", () => {
    // claude-opus-5-5 answered "`temperature` is deprecated for this model" (2026-10-12).
    for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-sonnet-5-5-vertex"]) {
      const req = buildRequest("anthropic", model, "sk-a", SYSTEM_AND_USER);
      expect(req.body).not.toHaveProperty("temperature");
      expect(req.body).toHaveProperty("max_tokens", 400);
    }
    for (const model of ["claude-sonnet-4-6", "claude-opus-4-8", "claude-sonnet-4-5-20250929"]) {
      const req = buildRequest("anthropic", model, "sk-a", SYSTEM_AND_USER);
      expect(req.body).toHaveProperty("temperature", 0.0);
    }
  });
});

describe("buildRequest — gemini", () => {
  test("role mapping, systemInstruction, key-as-query", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys-a" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const req = buildRequest("gemini", "gemini-1.5-pro", "GKEY", messages, 256, 0.2);
    expect(req.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
    );
    expect(req.headers).toEqual({ "Content-Type": "application/json" });
    expect(req.query).toEqual({ key: "GKEY" });
    expect(req.body).toEqual({
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "yo" }] },
      ],
      generationConfig: { maxOutputTokens: 256, temperature: 0.2 },
      systemInstruction: { parts: [{ text: "sys-a" }] },
    });
  });

  test("no system → no systemInstruction; assistant→model role", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "prior" },
      { role: "user", content: "hi" },
    ];
    const req = buildRequest("gemini", "gemini-pro", "GKEY", messages);
    expect(req.body).not.toHaveProperty("systemInstruction");
    expect(req.body).toHaveProperty("contents", [
      { role: "model", parts: [{ text: "prior" }] },
      { role: "user", parts: [{ text: "hi" }] },
    ]);
  });
});

describe("buildRequest — unsupported", () => {
  test("throws for unknown provider", () => {
    expect(() => buildRequest("cohere", "x", "k", SYSTEM_AND_USER)).toThrow(
      /Unsupported judge provider/,
    );
  });
});

describe("parseResponse — openai", () => {
  test("extracts message content", () => {
    const data = { choices: [{ message: { content: "hello world" } }] };
    expect(parseResponse("openai", data)).toBe("hello world");
  });

  test("null content → ''", () => {
    const data = { choices: [{ message: { content: null } }] };
    expect(parseResponse("openai", data)).toBe("");
  });

  test("missing choices → '' (fallback)", () => {
    expect(parseResponse("openai", {})).toBe("");
    expect(parseResponse("openai", { choices: [] })).toBe("");
    expect(parseResponse("openai", null)).toBe("");
  });
});

describe("parseResponse — anthropic", () => {
  test("joins text blocks, ignores non-text", () => {
    const data = {
      content: [
        { type: "text", text: "foo" },
        { type: "thinking", text: "IGNORED" },
        { type: "text", text: "bar" },
      ],
    };
    expect(parseResponse("anthropic", data)).toBe("foobar");
  });

  test("empty / missing content → ''", () => {
    expect(parseResponse("anthropic", {})).toBe("");
    expect(parseResponse("anthropic", { content: [] })).toBe("");
    expect(parseResponse("anthropic", null)).toBe("");
  });

  test("null and missing text blocks are ignored", () => {
    expect(parseResponse("anthropic", {
      content: [null, { type: "text" }, { type: "text", text: null }, { type: "text", text: "ok" }],
    })).toBe("ok");
  });
});

describe("parseResponse — gemini", () => {
  test("joins candidate parts", () => {
    const data = {
      candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }],
    };
    expect(parseResponse("gemini", data)).toBe("ab");
  });

  test("no candidates → ''", () => {
    expect(parseResponse("gemini", { candidates: [] })).toBe("");
    expect(parseResponse("gemini", {})).toBe("");
  });

  test("candidate without parts → ''", () => {
    expect(parseResponse("gemini", { candidates: [{ content: {} }] })).toBe("");
    expect(parseResponse("gemini", { candidates: [{}] })).toBe("");
  });

  test("null candidate and parts preserve the empty-text fallback", () => {
    expect(parseResponse("gemini", { candidates: [null] })).toBe("");
    expect(parseResponse("gemini", {
      candidates: [{ content: { parts: [null, {}, { text: null }, { text: "ok" }] } }],
    })).toBe("ok");
  });

  test("malformed → ''", () => {
    expect(parseResponse("gemini", null)).toBe("");
  });
});

describe("parseResponse — unsupported", () => {
  test("throws for unknown provider with well-formed data", () => {
    expect(() => parseResponse("cohere", { some: "data" })).toThrow(
      /Unsupported judge provider/,
    );
  });
});
