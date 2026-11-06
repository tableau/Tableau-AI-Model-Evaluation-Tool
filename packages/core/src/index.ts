/**
 * `@tableau-ai-eval/core` public surface: the shared building blocks used by both the
 * server (`@tableau-ai-eval/server`) and the evaluator (`@tableau-ai-eval/evals`).
 *
 * This barrel exists so consumers import from the package root
 * (`@tableau-ai-eval/core`) rather than reaching into `@tableau-ai-eval/core/src/...`. Deep
 * relative imports within core itself keep using explicit `.ts` paths.
 */

// Adapter contract + registry (the linchpin type shared across all packages).
export * from "./adapters/contract.ts";

// SQLite persistence.
export * from "./db/index.ts";
// DB read-path shape types (row/result shapes the read methods return).
export * from "./db/types.ts";
export * from "./run_lifecycle.ts";

// Server-sent events state + notifier + standalone SSE server.
export * from "./sse/state.ts";
export * from "./sse/notifier.ts";
export * from "./sse/server.ts";

// Tableau connectivity + TLS.
export * from "./tableau/session.ts";
export * from "./tableau/session_config.ts";
export * from "./tableau/tls.ts";
export * from "./tableau/preflight.ts";
export * from "./tableau/server_support.ts";
export * from "./tableau/trust.ts";
// credentials.ts is the canonical (and now sole) home of maskValue/
// redactSecrets — the byte-identical duplicate in db/index.ts was removed, so
// `export *` here is the single export path (no collision workaround needed).
export * from "./tableau/credentials.ts";

// The metric catalog (categories/weights/labels) + the scoring rules shared by
// the results page, the history score, the exports and the published
// datasource. Exported as a namespace (its names are generic: `verdict`,
// `categories`, …).
export * as metricCatalog from "./metrics/catalog.ts";
export type {
  StageMetrics as CatalogStageMetrics,
  CatalogMetric,
  Bucket as CatalogBucket,
  MetricDescription,
  Verdict as CatalogVerdict,
} from "./metrics/catalog.ts";

// LLM-as-judge scoring.
export * from "./judge/judge.ts";
export * from "./judge/palette_judge.ts";
export * from "./judge/narrative_judge.ts";
export * from "./judge/providers.ts";

// Test content embedded in the compiled binary (indexed pack, decoded per file on read).
export * from "./bundled_content.ts";
export * from "./content_pack.ts";
export * from "./content_fs.ts";

// Env config loader. config.ts also defines a `JudgeConfig` interface that
// duplicates the judge module's; the judge one wins at the barrel, so config's
// is re-exported under an unambiguous alias.
export {
  redact,
  loadTableauConfig,
  loadJudgeConfig,
  loadSecrets,
  describeConfig,
  type TableauConfig,
  type AiEvalSecrets,
  type JudgeConfig as JudgeEnvConfig,
} from "./config.ts";
