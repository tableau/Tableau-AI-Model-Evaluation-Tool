import { describe, expect, test } from "bun:test";
import {
  buildAnswerCorrectnessPrompt,
  buildFactualConsistencyPrompt,
  computeCabuJudgeMetrics,
  formatTemplate,
  parseJudgeJson,
  rowsKnown,
  type JudgeCaller,
} from "./judge.ts";
import {
  ANSWER_CORRECTNESS_TEMPLATE,
  FACTUAL_CONSISTENCY_TEMPLATE,
} from "./templates.ts";

describe("cabu judge — formatTemplate (Python str.format parity)", () => {
  test("substitutes named fields and unescapes doubled braces", () => {
    expect(formatTemplate("a {x} b {{lit}} c {y}", { x: "1", y: "2" })).toBe(
      "a 1 b {lit} c 2",
    );
  });
  test("missing field renders empty (defensive)", () => {
    expect(formatTemplate("{missing}", {})).toBe("");
  });
});

describe("cabu judge — prompt builders", () => {
  test("answerCorrectness fills all three placeholders", () => {
    const p = buildAnswerCorrectnessPrompt("Q?", "obs", "exp");
    expect(p).toContain("obs");
    expect(p).toContain("exp");
    // Doubled braces from the JSON schema example survive as single braces.
    expect(p).not.toContain("{{");
    // No leftover unfilled named placeholders.
    expect(p).not.toContain("{question}");
    expect(p).not.toContain("{observed_answer}");
    expect(p).not.toContain("{expected_answer}");
  });

  test("factualConsistency serializes non-string query_response_data as JSON", () => {
    const p = buildFactualConsistencyPrompt("Q?", "resp", "gt", [{ Sales: 100 }]);
    expect(p).toContain('[{"Sales":100}]');
    expect(p).not.toContain("{question}");
    expect(p).not.toContain("{query_response_data}");
  });

  test("templates preserve the rubric strings", () => {
    // sanity: the imported constants are non-trivial and carry the schema words.
    expect(ANSWER_CORRECTNESS_TEMPLATE.length).toBeGreaterThan(1000);
    expect(FACTUAL_CONSISTENCY_TEMPLATE.length).toBeGreaterThan(1000);
    expect(ANSWER_CORRECTNESS_TEMPLATE).toContain("Scoring Guidelines");
    expect(FACTUAL_CONSISTENCY_TEMPLATE).toContain("factual consistency");
  });
});

describe("cabu judge — parseJudgeJson", () => {
  test("parses fenced JSON and normalizes 0-10 to 0-1", () => {
    expect(parseJudgeJson('```json\n{"score": 8, "explanation": "good"}\n```')).toEqual({
      score: 0.8,
      explanation: "good",
    });
  });
  test("parses bare JSON", () => {
    expect(parseJudgeJson('{"score": 10}')).toEqual({ score: 1.0, explanation: null });
  });
  test("clamps out-of-range scores", () => {
    expect(parseJudgeJson('{"score": 15}').score).toBe(1.0);
    expect(parseJudgeJson('{"score": -3}').score).toBe(0.0);
  });
  test("recovers a {...} object embedded in prose", () => {
    expect(parseJudgeJson('Here you go: {"score": 5} thanks').score).toBe(0.5);
  });
  test("non-numeric score → null with reason", () => {
    const r = parseJudgeJson('{"score": "abc"}');
    expect(r.score).toBeNull();
    expect(r.explanation).toMatch(/non-numeric/);
  });
  test("empty / unparseable → null", () => {
    expect(parseJudgeJson("").score).toBeNull();
    expect(parseJudgeJson("no json here").score).toBeNull();
  });
});

describe("cabu judge — computeCabuJudgeMetrics", () => {
  const okCaller: JudgeCaller = async () => '{"score": 9, "explanation": "great"}';

  test("both-empty short-circuits answerCorrectness to 1.0 without an LLM call", async () => {
    let called = false;
    const caller: JudgeCaller = async () => {
      called = true;
      return "{}";
    };
    const calls: string[] = [];
    const entries = await computeCabuJudgeMetrics({
      question: "Q",
      observedAnswer: "",
      expectedAnswer: "",
      queryResponseData: null,
      judgeCfg: { provider: "openai", model: "gpt-4o", api_key: "k" },
      callJudge: async (a) => {
        calls.push(a.prompt);
        return caller(a);
      },
    });
    // Answer correctness is decided without the judge; coherence and
    // relevance still ask it and report its failure.
    expect(calls.some((p) => p.includes("observed answer correctly matches"))).toBe(false);
    expect(called).toBe(true);
    expect(entries[0]).toEqual({
      metric_id: "CabuJudge",
      metric_name: "answerCorrectness",
      score: 1.0,
      explanation: "Both expected and observed empty",
    });
    expect(entries.slice(1).map((e) => e.metric_name)).toEqual([
      "coherence_dashboard_qa",
      "relevance_dashboard_qa",
    ]);
    expect(entries.slice(1).every((e) => e.score === null)).toBe(true);
  });

  test("scores answerCorrectness + factualConsistency when data present", async () => {
    const entries = await computeCabuJudgeMetrics({
      question: "Q",
      observedAnswer: "obs",
      expectedAnswer: "exp",
      queryResponseData: [{ Sales: 100 }],
      judgeCfg: { provider: "openai", model: "gpt-4o", api_key: "k" },
      callJudge: okCaller,
    });
    expect(entries.map((e) => e.metric_name)).toEqual([
      "answerCorrectness",
      "factualConsistency",
      "coherence_dashboard_qa",
      "relevance_dashboard_qa",
    ]);
    expect(entries.every((e) => e.score === 0.9)).toBe(true);
  });

  test("no query_response_data → factualConsistency skipped", async () => {
    const entries = await computeCabuJudgeMetrics({
      question: "Q",
      observedAnswer: "obs",
      expectedAnswer: "exp",
      queryResponseData: null,
      judgeCfg: { provider: "openai", model: "gpt-4o", api_key: "k" },
      callJudge: okCaller,
    });
    expect(entries.map((e) => e.metric_name)).toEqual([
      "answerCorrectness",
      "coherence_dashboard_qa",
      "relevance_dashboard_qa",
    ]);
  });

  test("judge failure yields score=null Unavailable (never throws)", async () => {
    const failing: JudgeCaller = async () => {
      throw new Error("boom");
    };
    const entries = await computeCabuJudgeMetrics({
      question: "Q",
      observedAnswer: "obs",
      expectedAnswer: "exp",
      queryResponseData: [{ a: 1 }],
      judgeCfg: { provider: "openai", model: "gpt-4o", api_key: "k" },
      callJudge: failing,
    });
    expect(entries.map((e) => e.metric_name)).toEqual([
      "answerCorrectness",
      "factualConsistency",
      "coherence_dashboard_qa",
      "relevance_dashboard_qa",
    ]);
    for (const e of entries) {
      expect(e.score).toBeNull();
      expect(e.explanation).toMatch(/Unavailable: boom/);
    }
  });

  test("unparseable judge output yields Unavailable reason", async () => {
    const garbage: JudgeCaller = async () => "not json";
    const entries = await computeCabuJudgeMetrics({
      question: "Q",
      observedAnswer: "obs",
      expectedAnswer: "exp",
      queryResponseData: null,
      judgeCfg: { provider: "openai", model: "gpt-4o", api_key: "k" },
      callJudge: garbage,
    });
    expect(entries[0]!.score).toBeNull();
    expect(entries[0]!.explanation).toMatch(/Unavailable:/);
  });
});

describe("cabu judge — Dashboard Q&A coherence and relevance", () => {
  const cfg = { provider: "openai", model: "gpt-4.1", api_key: "k" };

  test("coherence reads the prose expectation (None when absent), relevance the case's kind", async () => {
    const prompts: string[] = [];
    await computeCabuJudgeMetrics({
      question: "Q",
      observedAnswer: "obs",
      expectedAnswer: "exp",
      queryResponseData: null,
      judgeCfg: cfg,
      callJudge: async (a) => {
        prompts.push(a.prompt);
        return '{"score": 10, "explanation": "fine"}';
      },
    });
    const coherence = prompts.filter((p) => p.includes("assessing the coherence"));
    const relevance = prompts.filter((p) => p.includes("assessing the relevance"));
    expect(coherence.length).toBe(1);
    expect(relevance.length).toBe(1);
    expect(coherence[0]).toContain("ground_truth: None");
    expect(relevance[0]).toContain("expected_output_type: SQ");
    expect(relevance[0]).toContain("answer_source: ANSWER_SOURCE_SEMANTIC_QUERY");
    expect(coherence[0]).not.toContain("{{");
    expect(coherence[0]).toContain('"properties"');
  });

  test("best score over |-separated truths and over , -separated output types", async () => {
    const entries = await computeCabuJudgeMetrics({
      question: "Q",
      observedAnswer: "obs",
      expectedAnswer: "exp",
      queryResponseData: null,
      judgeCfg: cfg,
      expectedProse: "first truth | second truth",
      outputType: "SQ, Clarify Intent",
      answerSource: "ANSWER_SOURCE_INSIGHTS",
      callJudge: async ({ prompt }) => {
        if (prompt.includes("ground_truth: second truth")) return '{"score": 8, "explanation": "b"}';
        if (prompt.includes("ground_truth: first truth")) return '{"score": 4, "explanation": "a"}';
        if (prompt.includes("expected_output_type: Clarify Intent")) return '{"score": 6, "explanation": "c"}';
        if (prompt.includes("expected_output_type: SQ")) return '{"score": 2, "explanation": "s"}';
        return '{"score": 0, "explanation": "x"}';
      },
    });
    const by = Object.fromEntries(entries.map((e) => [e.metric_name, e]));
    expect(by.coherence_dashboard_qa!.score).toBe(0.8);
    expect(by.coherence_dashboard_qa!.explanation).toBe("b");
    expect(by.relevance_dashboard_qa!.score).toBe(0.6);
    expect(by.relevance_dashboard_qa!.explanation).toBe("s; c");
  });
});


describe("factual consistency when the server sent no rows and no query (2026-10-21)", () => {
  const judgeCfg = { provider: "openai", model: "m", api_key: "k" };
  const callJudge: JudgeCaller = async () => '{"score": 10, "explanation": "fine"}';
  const run = (expectedAnswer: string, rows: unknown, rowsKnown: boolean) =>
    computeCabuJudgeMetrics({
      question: "q", observedAnswer: "The total is $5,368,804.69.", expectedAnswer,
      queryResponseData: rows, judgeCfg, callJudge, rowsKnown,
    });
  test("a data answer is Unavailable, with the reason naming the server flag", async () => {
    const fc = (await run("$5,368,804.69", [], false)).find((e) => e.metric_name === "factualConsistency")!;
    expect(fc.score).toBeNull();
    expect(String(fc.explanation)).toStartWith("Unavailable: the server sent neither the query rows");
    expect(String(fc.explanation)).toContain("ECT_Dev");
  });
  test("a clarification is still judged, and so is an answer whose query the server showed", async () => {
    const clar = (await run("Clarification needed - which segment?", [], false)).find((e) => e.metric_name === "factualConsistency")!;
    expect(clar.score).toBe(1.0);
    const shown = (await run("$5,368,804.69", [], true)).find((e) => e.metric_name === "factualConsistency")!;
    expect(shown.score).toBe(1.0);
    expect(rowsKnown({ query_response_data: [], semantic_query: "", llm_calls: 0, total_tokens: 0 })).toBe(false);
    expect(rowsKnown({ query_response_data: [], semantic_query: "SELECT 1" })).toBe(true);
    expect(rowsKnown({ query_response_data: [{ Total: 1 }] })).toBe(true);
  });
});
