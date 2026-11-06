/**
 * LIVE smoke test for the BYOK judge path (best-effort).
 *
 * Reads provider / model / api_key from ./config AT RUNTIME, builds a tiny
 * real scoring prompt, and makes ONE real judge call via the ported code,
 * printing the parsed scores. The API key is used in-memory only and is NEVER
 * printed or persisted. `config` is git-ignored.
 *
 * Run:  $HOME/.bun/bin/bun run scripts/smoke_judge.ts
 */

import { fileURLToPath } from "node:url";
import { computeJudgeMetrics, type RetryPolicy } from "@tableau-ai-eval/core";

const CONFIG_PATH = fileURLToPath(new URL("../config", import.meta.url));

interface ParsedConfig {
  provider: string;
  model: string;
  apiKey: string;
}

/**
 * Parse the credential file. Two line shapes are present:
 *   `Key: value`         (e.g. `Provider: openai`, `Model: gpt4.1`)
 *   `KEY = "value"`      (e.g. `OPENAI_API_KEY = "..."`)
 * We only extract what the smoke test needs — never echo values.
 */
function parseConfig(text: string): ParsedConfig {
  let provider = "";
  let model = "";
  let apiKey = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // `KEY = "value"` shape
    const eq = line.match(/^([A-Za-z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (eq) {
      const [, k, v] = eq;
      if (k === "OPENAI_API_KEY") apiKey = v.trim();
      continue;
    }

    // `Key: value` shape
    const colon = line.match(/^([A-Za-z0-9_ ]+?)\s*:\s*(.*)$/);
    if (colon) {
      const [, k, v] = colon;
      const key = k.trim().toLowerCase();
      if (key === "provider") provider = v.trim().toLowerCase();
      else if (key === "model") model = v.trim();
    }
  }
  return { provider, model, apiKey };
}

/** Normalize the known config model-name quirk into candidate strings. */
function candidateModels(configModel: string): string[] {
  const candidates: string[] = [];
  const m = (configModel || "").trim();
  if (m) candidates.push(m);
  // config says "gpt4.1" — likely meant "gpt-4.1"; add sensible corrections.
  if (m === "gpt4.1") {
    candidates.push("gpt-4.1", "gpt-4o");
  }
  // Always have a widely-available fallback last.
  if (!candidates.includes("gpt-4o")) candidates.push("gpt-4o");
  return candidates;
}

const NO_WAIT_RETRY: RetryPolicy = {
  attempts: 2, // keep smoke to 1–2 calls per model candidate
  waitMs: () => 0,
  sleep: () => Promise.resolve(),
};

async function main() {
  let text: string;
  try {
    text = await Bun.file(CONFIG_PATH).text();
  } catch (e) {
    console.error(`Could not read config at ${CONFIG_PATH}: ${e}`);
    process.exit(1);
  }

  const cfg = parseConfig(text);
  // Report presence only — never the value.
  console.log(
    `Parsed config: provider=${cfg.provider || "(missing)"} ` +
      `model=${cfg.model || "(missing)"} ` +
      `apiKey=${cfg.apiKey ? "present(len=" + cfg.apiKey.length + ")" : "MISSING"}`,
  );

  if (cfg.provider !== "openai") {
    console.log(
      `Smoke is scoped to openai; config provider is "${cfg.provider}". Skipping live call.`,
    );
    return;
  }
  if (!cfg.apiKey) {
    console.error("No OPENAI_API_KEY found in config; cannot run live smoke.");
    process.exit(1);
  }

  const input = {
    utterance: "What were total sales by region last quarter?",
    expectedReply:
      "Sales totaled $1.2M, led by the West region at $480K, followed by East at $360K.",
    actualReply:
      "Last quarter, total sales reached about $1.2M. The West led with $480K, East followed at $360K, and Central trailed.",
    expectedSpec: null as Record<string, unknown> | null,
    judgeCfg: {
      provider: "openai",
      api_key: cfg.apiKey,
      model: "", // filled per candidate below
      timeout_s: 30,
    },
  };

  const candidates = candidateModels(cfg.model);
  console.log(`Model candidates (in order): ${candidates.join(", ")}`);

  for (const model of candidates) {
    console.log(`\n--- Trying model: ${model} ---`);
    input.judgeCfg.model = model;
    const out = await computeJudgeMetrics(input, { retry: NO_WAIT_RETRY });

    const allUnavailable =
      out.length > 0 && out.every((m) => m.score === null);
    if (out.length === 0) {
      console.log("Result: [] (unconfigured / nothing to score) — unexpected here.");
      continue;
    }
    if (allUnavailable) {
      const reason = out[0].explanation ?? "";
      console.log(`Result: Unavailable — ${reason}`);
      // If it looks like a 404 (bad model name), try the next candidate.
      if (/404/.test(reason)) {
        console.log("Looks like a model-name 404; trying next candidate.");
        continue;
      }
      // Other failures (401/network): no point trying more models.
      console.log("Non-404 failure; stopping.");
      return;
    }

    // Success: print the parsed score shape (scores + reasons), NOT the key.
    console.log(`Result: SUCCESS with model "${model}". Parsed scores:`);
    for (const m of out) {
      console.log(
        `  ${m.metric_name}: score=${m.score}` +
          (m.explanation ? `  reason="${m.explanation}"` : ""),
      );
    }
    console.log(
      `\nParsed shape: ${out.length} dimension(s), each ` +
        `{ metric_id, metric_name, score:number|null, explanation:string|null }.`,
    );
    return;
  }

  console.log("\nAll model candidates exhausted without a successful score.");
}

main().catch((e) => {
  console.error("Smoke script crashed:", e);
  process.exit(1);
});
