import { test, expect, describe } from "bun:test";
import {
  computeJudgeMetrics,
  buildPrompt,
  parseJudgeResponse,
  coerceScore,
  JUDGE_METRIC_NAMES,
  CALC_JUDGE_METRIC_NAMES,
  JUDGE_METRIC_ID,
  DEFAULT_JUDGE_MODEL,
  JUDGE_MAX_TOKENS,
  callJudge,
  type RetryPolicy,
  type FetchFn,
} from "./judge.ts";

// Zero-delay retry policy so tests never wait.
const FAST_RETRY: RetryPolicy = {
  attempts: 3,
  waitMs: () => 0,
  sleep: () => Promise.resolve(),
};

// Helper: OpenAI-shaped success body wrapping arbitrary content string.
function openaiBody(content: string) {
  return { choices: [{ message: { content } }] };
}

const OPENAI_CFG = { provider: "openai", api_key: "sk-TEST", model: "gpt-4o" };

describe("coerceScore", () => {
  test("clamps to [0,1]", () => {
    expect(coerceScore(1.5)).toBe(1.0);
    expect(coerceScore(-0.2)).toBe(0.0);
    expect(coerceScore(0.42)).toBe(0.42);
  });
  test("numeric strings accepted", () => {
    expect(coerceScore("0.7")).toBe(0.7);
  });
  test("non-numbers → null", () => {
    expect(coerceScore("abc")).toBeNull();
    expect(coerceScore(null)).toBeNull();
    expect(coerceScore(undefined)).toBeNull();
    expect(coerceScore({})).toBeNull();
    expect(coerceScore(NaN)).toBeNull();
  });
});

describe("buildPrompt", () => {
  test("includes question, expected, actual", () => {
    const p = buildPrompt("Q?", "expected", "actual");
    expect(p).toContain("Q?");
    expect(p).toContain("expected");
    expect(p).toContain("actual");
    expect(p).toContain("coherence");
    expect(p).toContain("followUpRelevance");
  });
  test("empty placeholders", () => {
    const p = buildPrompt("Q?", "", "");
    expect(p).toContain("(none provided)");
    expect(p).toContain("(no reply produced)");
  });
  test("spec blob included when spec provided", () => {
    const p = buildPrompt("Q?", "e", "a", { fields: ["Sales"] });
    expect(p).toContain("Expected visualization specification");
    expect(p).toContain("Sales");
  });
});

describe("parseJudgeResponse", () => {
  test("direct JSON", () => {
    const obj = parseJudgeResponse('{"coherence": {"score": 0.5}}');
    expect(obj).toEqual({ coherence: { score: 0.5 } });
  });
  test("code-fenced JSON", () => {
    const obj = parseJudgeResponse('```json\n{"a": 1}\n```');
    expect(obj).toEqual({ a: 1 });
  });
  test("prose-wrapped first {...}", () => {
    const obj = parseJudgeResponse('Here you go: {"a": 1} thanks');
    expect(obj).toEqual({ a: 1 });
  });
  test("empty string → {}", () => {
    expect(parseJudgeResponse("")).toEqual({});
  });
  test("no json → {}", () => {
    expect(parseJudgeResponse("no json here")).toEqual({});
  });
  test("array top-level → {} (not a dict)", () => {
    expect(parseJudgeResponse("[1,2,3]")).toEqual({});
  });
});

describe("computeJudgeMetrics — unconfigured", () => {
  test("no provider → []", async () => {
    const out = await computeJudgeMetrics(
      { utterance: "Q", judgeCfg: { api_key: "k" } },
      { retry: FAST_RETRY },
    );
    expect(out).toEqual([]);
  });
  test("no api_key → []", async () => {
    const out = await computeJudgeMetrics(
      { utterance: "Q", judgeCfg: { provider: "openai" } },
      { retry: FAST_RETRY },
    );
    expect(out).toEqual([]);
  });
  test("empty cfg → []", async () => {
    const out = await computeJudgeMetrics(
      { utterance: "Q", judgeCfg: {} },
      { retry: FAST_RETRY },
    );
    expect(out).toEqual([]);
  });
  test("nothing to score (no utterance, no reply) → []", async () => {
    const out = await computeJudgeMetrics(
      { utterance: "", actualReply: "", judgeCfg: OPENAI_CFG },
      { retry: FAST_RETRY },
    );
    expect(out).toEqual([]);
  });
});

describe("computeJudgeMetrics — happy path", () => {
  test("valid JSON scores → four metrics with scores + reasons", async () => {
    const content = JSON.stringify({
      coherence: { score: 0.82, reason: "flows well" },
      insightfulness: { score: 0.45, reason: "restates" },
      factualGrounding: { score: 0.9, reason: "grounded" },
      followUpRelevance: { score: 0.6, reason: "invites" },
    });
    const fetchFn = ((async () =>
      ({
        status: 200,
        json: async () => openaiBody(content),
        text: async () => "",
      }) as unknown as Response) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );

    expect(out.length).toBe(4);
    expect(out.map((m) => m.metric_name)).toEqual([...JUDGE_METRIC_NAMES]);
    expect(out.every((m) => m.metric_id === JUDGE_METRIC_ID)).toBe(true);
    expect(out[0]).toEqual({
      metric_id: JUDGE_METRIC_ID,
      metric_name: "coherence",
      score: 0.82,
      explanation: "flows well",
    });
    expect(out[2].score).toBe(0.9);
  });

  test("bare-number shape (older deployments) tolerated", async () => {
    const content = JSON.stringify({
      coherence: 0.7,
      insightfulness: 0.3,
      factualGrounding: 0.8,
      followUpRelevance: 0.5,
    });
    const fetchFn = ((async () =>
      ({
        status: 200,
        json: async () => openaiBody(content),
        text: async () => "",
      }) as unknown as Response) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(out.length).toBe(4);
    expect(out[0].score).toBe(0.7);
    expect(out[0].explanation).toBeNull();
  });

  test("missing dimension is simply omitted (null score dropped)", async () => {
    const content = JSON.stringify({
      coherence: { score: 0.7 },
      // others missing
    });
    const fetchFn = ((async () =>
      ({
        status: 200,
        json: async () => openaiBody(content),
        text: async () => "",
      }) as unknown as Response) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(out.length).toBe(1);
    expect(out[0].metric_name).toBe("coherence");
  });
});

describe("computeJudgeMetrics — malformed JSON → Unavailable", () => {
  test("unparseable output → four Unavailable dimensions", async () => {
    const fetchFn = ((async () =>
      ({
        status: 200,
        json: async () => openaiBody("not json at all"),
        text: async () => "",
      }) as unknown as Response) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(out.length).toBe(4);
    expect(out.map((m) => m.metric_name)).toEqual([...JUDGE_METRIC_NAMES]);
    expect(out.every((m) => m.score === null)).toBe(true);
    expect(out.every((m) => m.explanation?.startsWith("Unavailable:"))).toBe(true);
    expect(out[0].explanation).toContain("unparseable");
  });
});

describe("computeJudgeMetrics — retries", () => {
  test("all retries fail (5xx) → Unavailable, does NOT throw, 3 attempts", async () => {
    let calls = 0;
    const fetchFn = ((async () => {
      calls++;
      return {
        status: 500,
        json: async () => ({}),
        text: async () => "server boom",
      } as unknown as Response;
    }) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(calls).toBe(3); // 3 attempts
    expect(out.length).toBe(4);
    expect(out.every((m) => m.score === null)).toBe(true);
    expect(out.every((m) => m.explanation?.startsWith("Unavailable:"))).toBe(true);
  });

  test("429 is retried then eventually succeeds", async () => {
    let calls = 0;
    const content = JSON.stringify({ coherence: { score: 1.0 } });
    const fetchFn = ((async () => {
      calls++;
      if (calls < 3) {
        return {
          status: 429,
          json: async () => ({}),
          text: async () => "rate limited",
        } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => openaiBody(content),
        text: async () => "",
      } as unknown as Response;
    }) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(calls).toBe(3);
    expect(out.length).toBe(1);
    expect(out[0].score).toBe(1.0);
  });

  test("network error retried, then Unavailable if never recovers", async () => {
    let calls = 0;
    const fetchFn = ((async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(calls).toBe(3);
    expect(out.length).toBe(4);
    expect(out.every((m) => m.score === null)).toBe(true);
  });

  test("4xx (bad key) is NOT retried → single attempt, Unavailable", async () => {
    let calls = 0;
    const fetchFn = ((async () => {
      calls++;
      return {
        status: 401,
        json: async () => ({}),
        text: async () => "unauthorized",
      } as unknown as Response;
    }) as unknown) as FetchFn;

    const out = await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: OPENAI_CFG },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(calls).toBe(1); // non-retryable
    expect(out.length).toBe(4);
    expect(out.every((m) => m.score === null)).toBe(true);
    expect(out[0].explanation).toContain("401");
  });
});

describe("computeJudgeMetrics — model default", () => {
  test("uses DEFAULT_JUDGE_MODEL when model omitted", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchFn = ((async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string);
      return {
        status: 200,
        json: async () => openaiBody('{"coherence":{"score":0.5}}'),
        text: async () => "",
      } as unknown as Response;
    }) as unknown) as FetchFn;

    await computeJudgeMetrics(
      { utterance: "Q?", actualReply: "A", judgeCfg: { provider: "openai", api_key: "k" } },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(seenBody.model).toBe(DEFAULT_JUDGE_MODEL);
  });
});

// A calculated field's explanation
// is judged on the calculation rubric, against both formulas.
describe("computeJudgeMetrics — calculation rubric", () => {
  test("calc explanations are judged on grounding and coherence against the formulas", async () => {
    const content = JSON.stringify({
      coherence: { score: 0.9, reason: "clear" },
      factualGrounding: { score: 0.6, reason: "says count, formula sums" },
    });
    let prompt = "";
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join("\n");
      return { status: 200, json: async () => openaiBody(content), text: async () => "" } as unknown as Response;
    }) as unknown as FetchFn;
    const out = await computeJudgeMetrics(
      {
        utterance: "days since last activity",
        expectedReply: null,
        actualReply: "This finds the most recent activity date and counts the days to today.",
        judgeCfg: OPENAI_CFG,
        expectedFormula: "DATEDIFF('day', [Activity Date], TODAY())",
        actualFormula: "DATEDIFF('day', MAX([Activity Date]), TODAY())",
      },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(out.map((m) => m.metric_name)).toEqual([...CALC_JUDGE_METRIC_NAMES]);
    expect(Object.fromEntries(out.map((m) => [m.metric_name, m.score]))).toEqual({
      coherence: 0.9,
      factualGrounding: 0.6,
    });
    expect(prompt).toContain("DATEDIFF('day', [Activity Date], TODAY())");
    expect(prompt).toContain("MAX([Activity Date])");
    expect(prompt).not.toContain("insightfulness");
    expect(prompt).not.toContain("visualization specification");
  });

  test("calc judge failure marks only its two dimensions unavailable", async () => {
    const fetchFn = (async () =>
      ({ status: 401, json: async () => ({}), text: async () => "bad key" }) as unknown as Response) as unknown as FetchFn;
    const out = await computeJudgeMetrics(
      { utterance: "u", actualReply: "a", judgeCfg: OPENAI_CFG, actualFormula: "SUM([Sales])" },
      { fetchFn, retry: FAST_RETRY },
    );
    expect(out.map((m) => m.metric_name)).toEqual(["coherence", "factualGrounding"]);
    expect(out.every((m) => m.score === null)).toBe(true);
  });
});

// Judge requests leave room for a long answer.
test("the judge call leaves room for a long answer", async () => {
  // claude-opus-5-5 answers the palette rubric in ~900 tokens; a 400-token
  // cap cut the JSON off and 93 of 102 palette scores were Unavailable.
  let sent: Record<string, unknown> = {};
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
  }) as unknown as FetchFn;
  await callJudge({
    provider: "anthropic",
    model: "claude-opus-5-5",
    apiKey: "k",
    prompt: "rate this",
    timeoutS: 5,
    fetchFn,
    retry: FAST_RETRY,
  });
  expect(sent.max_tokens).toBe(JUDGE_MAX_TOKENS);
  expect(JUDGE_MAX_TOKENS).toBeGreaterThanOrEqual(1500);
});
