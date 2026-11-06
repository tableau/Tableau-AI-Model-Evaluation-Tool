import { test, expect } from "bun:test";
import {
  redactSecrets,
  maskValue,
  isRedacted,
  runnerBaseUrl,
  buildLlmCredentials,
  buildTableauCredentials,
  parseSmokeConfig,
  redactSmokeConfig,
} from "./credentials.ts";

// -- redaction ---------------------------------------------------------------

test("maskValue masks long strings to ****last4 and short to ****", () => {
  expect(maskValue("supersecretvalue")).toBe("****alue");
  expect(maskValue("short")).toBe("****");
  expect(maskValue("")).toBe("");
  expect(maskValue(null)).toBeNull();
  expect(maskValue(true)).toBe("****");
});

test("redactSecrets masks secret-named keys recursively and never leaks the secret", () => {
  const SECRET = "topsecret-pat-value-1234";
  const config = {
    tableau_server: "https://tab.example.com",
    tableau_site: "MySite",
    tableau_pat_name: "tableau-ai-eval-test",
    tableau_pat_value: SECRET,
    llm_key: "sk-abcdef123456",
    nested: {
      gateway_headers: { Authorization: "Bearer xyz-token-value" },
      api_token: "abc-token-9999",
    },
    list: [{ password: "hunter2xyz" }],
    innocent: "keep-me",
  };

  const redacted = redactSecrets(config) as typeof config;

  // The full serialized output must not contain any raw secret substring.
  const serialized = JSON.stringify(redacted);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain("sk-abcdef123456");
  expect(serialized).not.toContain("Bearer xyz-token-value");
  expect(serialized).not.toContain("abc-token-9999");
  expect(serialized).not.toContain("hunter2xyz");

  // Masked shapes.
  expect(redacted.tableau_pat_value).toBe("****1234");
  expect(redacted.llm_key).toBe("****3456");
  expect(redacted.nested.gateway_headers.Authorization).toBe("****alue");
  expect(redacted.nested.api_token).toBe("****9999");
  expect(redacted.list[0].password).toBe("****2xyz");

  // Non-secret fields survive untouched.
  expect(redacted.tableau_server).toBe("https://tab.example.com");
  expect(redacted.tableau_pat_name).toBe("tableau-ai-eval-test");
  expect(redacted.innocent).toBe("keep-me");

  // Original object is not mutated.
  expect(config.tableau_pat_value).toBe(SECRET);
});

test("isRedacted recognises the placeholder", () => {
  expect(isRedacted("****1234")).toBe(true);
  expect(isRedacted("realvalue")).toBe(false);
  expect(isRedacted(undefined)).toBe(false);
});

// -- runner base url ---------------------------------------------------------

test("runnerBaseUrl strips the /content-exploration suffix", () => {
  expect(runnerBaseUrl("https://tab.example.com/content-exploration")).toBe(
    "https://tab.example.com",
  );
  expect(runnerBaseUrl("https://tab.example.com/content-exploration/")).toBe(
    "https://tab.example.com",
  );
  expect(runnerBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  expect(runnerBaseUrl("")).toBe("");
  expect(runnerBaseUrl(null)).toBe("");
});

// -- LLM credential build/validate ------------------------------------------

test("buildLlmCredentials builds payload for a valid config", () => {
  const r = buildLlmCredentials({
    gateway_url: "https://egpt.example.com",
    llm_key: "real-key-12345",
    org_id: "org-1",
    cert_path: "/certs/client.pem",
  });
  expect(r).toEqual({
    payload: {
      llmUrl: "https://egpt.example.com",
      llmKey: "real-key-12345",
      orgId: "org-1",
      certPath: "/certs/client.pem",
    },
  });
});

test("buildLlmCredentials refuses a schemeless gateway url", () => {
  const r = buildLlmCredentials({
    gateway_url: "tableau.example.com",
    llm_key: "real-key",
  });
  expect(r).toEqual({ skip: "schemeless" });
});

test("buildLlmCredentials skips the placeholder key", () => {
  const r = buildLlmCredentials({
    gateway_url: "https://egpt.example.com",
    llm_key: "generativeAiLLMProviderAPIKeySet",
  });
  expect(r).toEqual({ skip: "placeholder" });
});

test("buildLlmCredentials skips when missing gateway/key", () => {
  expect(buildLlmCredentials({})).toEqual({ skip: "missing" });
});

// -- Tableau credential build ------------------------------------------------

test("buildTableauCredentials returns null without ces_url", () => {
  expect(buildTableauCredentials({})).toBeNull();
});

test("buildTableauCredentials strips suffix and includes optional PAT", () => {
  const p = buildTableauCredentials({
    ces_url: "https://tab.example.com/content-exploration",
    tableau_site: "MySite",
    tableau_pat_name: "pat",
    tableau_pat_value: "secretval",
  });
  expect(p).toEqual({
    server: "https://tab.example.com",
    site: "MySite",
    pat_name: "pat",
    pat_value: "secretval",
  });
});

// -- config file parsing (smoke) --------------------------------------------

test("parseSmokeConfig parses the ./config Key: Value format", () => {
  const raw = [
    "Tableau Server URL: https://tableau.example.com",
    "Site content URL: TabAgentOnPremSIteSettings",
    "PAT Name: tableau-ai-eval-test",
    "PAT Secret: ultra-secret-value-abcd",
  ].join("\n");
  const cfg = parseSmokeConfig(raw);
  expect(cfg.serverUrl).toBe("https://tableau.example.com");
  expect(cfg.site).toBe("TabAgentOnPremSIteSettings");
  expect(cfg.patName).toBe("tableau-ai-eval-test");
  expect(cfg.patSecret).toBe("ultra-secret-value-abcd");
});

test("parseSmokeConfig throws on missing fields", () => {
  expect(() => parseSmokeConfig("Tableau Server URL: https://x")).toThrow(
    /missing required field/,
  );
});

test("redactSmokeConfig never exposes the secret", () => {
  const cfg = {
    serverUrl: "https://tableau.example.com",
    site: "TabAgentOnPremSIteSettings",
    patName: "tableau-ai-eval-test",
    patSecret: "ultra-secret-value-abcd",
  };
  const redacted = redactSmokeConfig(cfg);
  expect(JSON.stringify(redacted)).not.toContain("ultra-secret-value-abcd");
  expect(redacted.patSecret).toBe("****abcd");
  expect(redacted.patName).toBe("tableau-ai-eval-test");
});
