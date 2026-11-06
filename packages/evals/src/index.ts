/**
 * `@tableau-ai-eval/evals` public surface: eval harness runners,
 * metrics library, calc-formula validator, and the concrete eval adapters
 * (nlq / prep_server / cabu / palettes).
 *
 * The adapter-registration seam between the server and the evaluator lives
 * here: `registerAdapters()` imports the concrete adapter modules so their
 * top-level `register(...)` side effects populate the process-global registry
 * in `@tableau-ai-eval/core`. The server calls this once at startup. `@tableau-ai-eval/core`
 * itself must NOT import these (that would create a package cycle), which is
 * why the old lazy self-import table was removed from `core/adapters/contract`.
 */

let _registered = false;

// Static side-effect imports: evaluating these modules runs their top-level
// `register(new XAdapter(...))` calls synchronously, so simply importing this
// barrel (or calling registerAdapters) guarantees the concrete adapters are in
// the shared registry. Kept as explicit imports (not only dynamic) so the
// registration is synchronous and race-free for an immediately-submitted run.
import "./adapters/nlq.ts";
import "./adapters/cabu/adapter.ts";
import "./adapters/palettes.ts";
import "./adapters/prep_server.ts";

/**
 * Register the concrete eval adapters (nlq, prep_server, cabu, palettes) into the
 * shared `@tableau-ai-eval/core` registry. The registration itself already happened via
 * the static side-effect imports above when this module was evaluated; this
 * function is the explicit, idempotent entrypoint the server calls at startup
 * to make the dependency obvious and to force this module to load.
 */
export async function registerAdapters(): Promise<void> {
  _registered = true;
}

/** True once registerAdapters() has been invoked (diagnostic helper). */
export function adaptersRegistered(): boolean {
  return _registered;
}

// Concrete adapters. Each adapter module has internal helpers that share names
// across adapters (`HarnessRunner`, `serializeCase`), so they are exposed under
// per-adapter namespaces to avoid barrel collisions; the main public
// classes/factories are also re-exported flat for convenience.
export * as nlqAdapter from "./adapters/nlq.ts";
export * as cabuAdapter from "./adapters/cabu/adapter.ts";
export * as paletteAdapter from "./adapters/palettes.ts";
export * from "./adapters/prep_server.ts";
export { PaletteAdapter, createPaletteAdapter } from "./adapters/palettes.ts";
export { computePaletteMetrics } from "./metrics/palette_metrics.ts";
export {
  NlqEvaluatorAdapter,
  createNlqAdapter,
  type NlqAdapterOptions,
  type HarnessCase,
  type HarnessConversation,
  type HarnessCaseResult,
} from "./adapters/nlq.ts";
export { SUITE_KINDS, type SuiteKind, type PrepRecord, type PrepCase } from "./prep/bench.ts";
export {
  CabuAdapter,
  createCabuAdapter,
  RUNNER_NAME,
  resolveLuids,
  answerForJudging,
  renderRowsAsMarkdown,
  type CabuCase,
  type CabuOutcome,
  type CabuSuiteLoader,
  type CabuClientFactory,
  type CabuAdapterOptions,
} from "./adapters/cabu/adapter.ts";
export * from "./adapters/cabu/client.ts";
export * from "./adapters/cabu/judge.ts";

// Harness runners.
export * from "./harness/nlq_runner.ts";
export * from "./harness/cabu_runner.ts";

// The Prep test bench (prep-bench/): suites, checker, row serialization.
export {
  bundledPrepRoot,
  dataName as prepDataName,
  flattenSuite as flattenPrepSuite,
  prepCasesBase,
  prepRoot,
  resolveSuite as resolvePrepSuite,
} from "./prep/bench.ts";
export { bestFormulaSimilarity, checkCalc, formulaSimilarity, parseFieldMetadata, PREP_FUNCTIONS } from "./prep/calc_checker.ts";
export { intentExplanation, intentScore, normalizeIntent, PLAUSIBLE_CREDIT } from "./prep/intent.ts";
export {
  GENERATOR_STAGE as PREP_GENERATOR_STAGE,
  SCORER_STAGE as PREP_SCORER_STAGE,
  serializeCase as serializePrepCase,
} from "./prep/serialize.ts";
export * from "./harness/metrics_config.ts";

// Metrics library.
export * from "./metrics/classes.ts";
export * from "./metrics/viz.ts";
export * from "./metrics/date_entities.ts";

// Calc-formula validator.
export * from "./validator/tableau_validator.ts";
export * from "./validator/parser.ts";
export * from "./validator/lexer.ts";
export * from "./validator/dynamic_validator.ts";
export * from "./validator/function_types.ts";
