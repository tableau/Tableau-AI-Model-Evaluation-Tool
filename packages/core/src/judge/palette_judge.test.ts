/**
 * The palette rubric is scored by the tool's configured judge, not by a model
 * pinned in the evaluator's metrics file (which, on the customer path, meant
 * the site's model judging its own palettes).
 * Covers request, response, and error handling.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPaletteJudgePrompt,
  computePaletteJudgeMetrics,
  parsePaletteJudgeJson,
  PALETTE_JUDGE_METRIC_ID,
} from "./palette_judge.ts";
import type { FetchFn, JudgeConfig, RetryPolicy } from "./judge.ts";

const CFG: JudgeConfig = { provider: "openai", model: "gpt-4.1", api_key: "k" };

// A no-wait retry so a failing test doesn't sleep the tenacity backoff.
const NO_WAIT: RetryPolicy = {
  attempts: 1,
  waitMs: () => 0,
  sleep: () => Promise.resolve(),
};

/** A fake fetch returning the given OpenAI-shaped assistant text. */
function fakeFetch(text: string): FetchFn {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as FetchFn;
}

function throwingFetch(status: number): FetchFn {
  return (async () =>
    new Response("service unavailable", { status })) as unknown as FetchFn;
}

describe("palette judge prompt", () => {
  test("carries the utterance, palette type and palette", () => {
    const p = buildPaletteJudgePrompt("ocean depths", "sequential", ["#001", "#002"]);
    expect(p).toContain("User Utterance: `ocean depths`");
    expect(p).toContain("Requested Palette Type: `sequential`");
    expect(p).toContain('["#001","#002"]');
    expect(p).not.toContain("{{{");
    expect(p.startsWith("You are an expert at evaluating color palettes")).toBe(true);
  });

  test("defaults an empty palette type to regular and empty palette to []", () => {
    const p = buildPaletteJudgePrompt("", null, []);
    expect(p).toContain("Requested Palette Type: `regular`");
    expect(p).toContain("Generated Color Palette Response:\n[]");
  });
});

describe("parsePaletteJudgeJson", () => {
  test("parses scores and reasons from a fenced JSON block", () => {
    const text =
      '```json\n{"valid": true, "relevance": 0.8, "design": 0.65, ' +
      '"validReasoning": "all hex", "relevanceReasoning": "fits", "designReasoning": "ok"}\n```';
    const { scores, reasons } = parsePaletteJudgeJson(text);
    expect(scores).toEqual({ valid: 1.0, relevance: 0.8, design: 0.65 });
    expect(reasons.valid).toBe("all hex");
  });

  test("returns empty maps when nothing parseable came back", () => {
    expect(parsePaletteJudgeJson("no json here")).toEqual({ scores: {}, reasons: {} });
  });
});

describe("computePaletteJudgeMetrics", () => {
  test("scores into three entries with the palette metric_id", async () => {
    const entries = await computePaletteJudgeMetrics(
      { utterance: "u", paletteType: "regular", palette: ["#fff"], judgeCfg: CFG },
      { fetchFn: fakeFetch('{"valid": false, "relevance": 1, "design": 0.5, "designReasoning": "meh"}'), retry: NO_WAIT },
    );
    expect(entries.map((e) => [e.metric_name, e.score])).toEqual([
      ["valid", 0.0],
      ["relevance", 1.0],
      ["design", 0.5],
    ]);
    expect(entries[2]!.explanation).toBe("meh");
    expect(entries.every((e) => e.metric_id === PALETTE_JUDGE_METRIC_ID)).toBe(true);
  });

  test("a judge failure yields Unavailable per metric (never throws)", async () => {
    const entries = await computePaletteJudgeMetrics(
      { utterance: "u", paletteType: "regular", palette: ["#fff"], judgeCfg: CFG },
      { fetchFn: throwingFetch(502), retry: NO_WAIT },
    );
    expect(entries.map((e) => e.metric_name)).toEqual(["valid", "relevance", "design"]);
    expect(entries.every((e) => e.score === null && (e.explanation ?? "").includes("Unavailable"))).toBe(true);
  });

  test("an unconfigured judge returns [] (not requested)", async () => {
    const entries = await computePaletteJudgeMetrics(
      { utterance: "u", paletteType: "regular", palette: ["#fff"], judgeCfg: {} },
      { fetchFn: fakeFetch("{}"), retry: NO_WAIT },
    );
    expect(entries).toEqual([]);
  });

  test("no palette to score yields Unavailable", async () => {
    const entries = await computePaletteJudgeMetrics(
      { utterance: "u", paletteType: "regular", palette: [], judgeCfg: CFG },
      { fetchFn: fakeFetch("{}"), retry: NO_WAIT },
    );
    expect(entries.every((e) => e.score === null && (e.explanation ?? "").includes("no palette"))).toBe(true);
  });

  test("unparseable judge output yields Unavailable", async () => {
    const entries = await computePaletteJudgeMetrics(
      { utterance: "u", paletteType: "regular", palette: ["#fff"], judgeCfg: CFG },
      { fetchFn: fakeFetch("not json at all"), retry: NO_WAIT },
    );
    expect(entries.every((e) => e.score === null && (e.explanation ?? "").includes("Unavailable"))).toBe(true);
  });
});
