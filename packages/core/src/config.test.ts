import { test, expect, describe } from "bun:test";
import {
  loadTableauConfig,
  loadJudgeConfig,
  loadSecrets,
  describeConfig,
  redact,
} from "./config.ts";

// Dummy values only — never real secrets.
const FULL_ENV: NodeJS.ProcessEnv = {
  TABLEAU_SERVER_URL: "https://tableau.example.com",
  TABLEAU_SITE_CONTENT_URL: "SiteA",
  TABLEAU_PAT_NAME: "pat-1",
  TABLEAU_PAT_SECRET: "secret-value-abcd",
  JUDGE_PROVIDER: "openai",
  JUDGE_MODEL: "gpt-4.1",
  OPENAI_API_KEY: "sk-dummy-key-wxyz",
};

describe("redact", () => {
  test("keeps only last 4 chars", () => {
    expect(redact("secret-value-abcd")).toBe("****abcd");
  });
  test("handles short and empty", () => {
    expect(redact("ab")).toBe("****");
    expect(redact(undefined)).toBe("(unset)");
  });
});

describe("loadTableauConfig", () => {
  test("parses full env", () => {
    const t = loadTableauConfig(FULL_ENV)!;
    expect(t.serverUrl).toBe("https://tableau.example.com");
    expect(t.siteContentUrl).toBe("SiteA");
    expect(t.patName).toBe("pat-1");
    expect(t.patSecret).toBe("secret-value-abcd");
  });
  test("undefined when required fields missing", () => {
    expect(loadTableauConfig({ TABLEAU_SERVER_URL: "x" })).toBeUndefined();
  });
});

describe("loadJudgeConfig", () => {
  test("openai default key var", () => {
    const j = loadJudgeConfig(FULL_ENV)!;
    expect(j.provider).toBe("openai");
    expect(j.model).toBe("gpt-4.1");
    expect(j.apiKey).toBe("sk-dummy-key-wxyz");
  });
  test("picks provider-specific key var", () => {
    const j = loadJudgeConfig({
      JUDGE_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "ant-dummy",
    })!;
    expect(j.provider).toBe("anthropic");
    expect(j.apiKey).toBe("ant-dummy");
  });
  test("undefined when key missing", () => {
    expect(loadJudgeConfig({ JUDGE_PROVIDER: "openai" })).toBeUndefined();
  });
});

describe("describeConfig", () => {
  test("never exposes raw secrets", () => {
    const desc = describeConfig(FULL_ENV);
    const serialized = JSON.stringify(desc);
    expect(serialized).not.toContain("secret-value-abcd");
    expect(serialized).not.toContain("sk-dummy-key-wxyz");
    expect(serialized).toContain("****abcd");
    expect(serialized).toContain("****wxyz");
  });
  test("reports not-configured cleanly", () => {
    const desc = describeConfig({});
    expect(desc.tableau).toBe("(not configured)");
    expect(desc.judge).toBe("(not configured)");
  });
});

describe("loadSecrets", () => {
  test("aggregates both", () => {
    const s = loadSecrets(FULL_ENV);
    expect(s.tableau).toBeDefined();
    expect(s.judge).toBeDefined();
  });
});
