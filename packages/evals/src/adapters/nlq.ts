/**
 * NLQ harness adapter.
 * Tool-side contract only.
 *
 * ## Explicit paths and per-run state
 *
 *   - `session()` is a pure lifecycle seam that installs/uninstalls an
 *     injectable `HarnessRunner` and does no process-global mutation.
 *   - The actual harness invocation (loading runners, discovering cases,
 *     running a case, evaluating metrics) is abstracted behind the
 *     `HarnessRunner` interface. This is the single pluggable seam we can wire
 *     to the native metrics engine, or replace
 *     with a fake in tests. It is path-explicit: the runner receives the
 *     resolved config and returns plain data — it never chdirs or writes files.
 *
 * The tool-side contract includes:
 *   - suite loading shape (`SuitePlan` totals / skeletons / conversation_ids),
 *   - conversation-batch iteration,
 *   - result-row normalization (`serializeCase`),
 *   - resume/skip via `completedIds` at CONVERSATION granularity (skip a
 *     conversation only when EVERY one of its case ids is completed),
 *   - `shouldStop()` checks at case boundaries.
 */

import type {
  AdapterSession,
  CaseSkeleton,
  EmitCase,
  EvalAdapter,
  MetricEntry,
  RowError,
  RowPayload,
  RunConfig,
  ShouldStop,
  SuitePlan,
} from "@tableau-ai-eval/core";
import { register, resolveMaxConcurrency } from "@tableau-ai-eval/core";
import { NlqHarnessRunner } from "../harness/nlq_runner.ts";

// ---------------------------------------------------------------------------
// The injectable harness seam
// ---------------------------------------------------------------------------

/**
 * A single case as the harness sees it. `id` groups into conversations via the
 * loader's `HarnessConversation`. `expected` is the up-front reference answer.
 */
export interface HarnessCase {
  id: string;
  runner: string;
  datasource?: string | null;
  utterance: string;
  turn?: number;
  expected?: Record<string, unknown> | null;
  /**
   * The requested colour-palette type (`inputs[].arguments.palette_type`),
   * carried for palette suites: the deterministic palette metrics pick their
   * rubric by type (regular / sequential / diverging), and the BYOK palette
   * judge is told which type was requested.
   */
  paletteType?: string | null;
  /** Captured dashboard artifacts/metadata for NarrativeRunner. */
  arguments?: Record<string, unknown> | null;
  isEnd?: boolean;
}

/** A conversation is an ordered list of cases (multi-turn). */
export type HarnessConversation = HarnessCase[];

/**
 * The result of running + evaluating one case. Mirrors the fields
 * `_serialize_test_case` reads off the harness `TestCase.result`.
 */
export interface HarnessCaseResult {
  /** Model's structured output. */
  actual?: Record<string, unknown> | null;
  /** Overall latency in seconds. */
  latency?: number | null;
  /** Case-level errors, already in row-error shape. */
  errors?: RowError[];
  /** Computed metrics keyed by stage. */
  metrics?: Record<string, MetricEntry[]>;
  debugInfo?: Record<string, unknown> | null;
  info?: Record<string, unknown> | null;
  /**
   * The runner's `evaluator_data` keys the serializer reads
   * (`datasource_fields`, `scoped_datasource_fields`, `semanticsearch_results`).
   */
  evaluatorData?: Record<string, unknown> | null;
}

/**
 * The pluggable harness invocation seam. A real implementation would drive the
 * metrics engine; tests inject a fake.
 *
 * Deliberately path-explicit and side-effect-free at the module level: no
 * chdir, no credential files, no global mutation.
 */
export interface HarnessRunner {
  /**
   * Discover and load the suite's conversations for the given config. Throws
   * when nothing runnable is found (the adapter re-raises as a load error).
   */
  loadConversations(config: RunConfig): Promise<HarnessConversation[]> | HarnessConversation[];

  /**
   * Run + evaluate a single case. `prefixes` are utterance prefixes to prepend
   * (mirrors the harness `case.utterance = " ".join([*prefixes, utterance])`).
   */
  runCase(
    testCase: HarnessCase,
    config: RunConfig,
    prefixes: string[],
  ): Promise<HarnessCaseResult> | HarnessCaseResult;
}

// ---------------------------------------------------------------------------
// Serialization (harness case + result → row payload)
// ---------------------------------------------------------------------------

function serializeSkeleton(c: HarnessCase): CaseSkeleton {
  return {
    test_case_id: c.id,
    runner: c.runner,
    datasource: c.datasource ?? null,
    utterance: c.utterance,
    expected: c.expected ?? {},
  };
}

/**
 * The field names the server's search matched and scoped the question to, as
 * the Tableau Agent runner records them (`scoped_datasource_fields`,
 * `semanticsearch_results`, `datasource_fields`); counts and captions only, so
 * a row stays small. Empty when the runner recorded nothing.
 */
export function serverFieldScope(evaluatorData: Record<string, unknown>): Record<string, unknown> {
  const captions = (items: unknown): string[] => {
    const out: string[] = [];
    for (const it of Array.isArray(items) ? items : []) {
      const cap =
        it && typeof it === "object"
          ? (it as Record<string, unknown>).caption ||
            (it as Record<string, unknown>).fieldName ||
            (it as Record<string, unknown>).name
          : it;
      if (cap) out.push(String(cap));
    }
    return out;
  };
  const scope: Record<string, unknown> = {};
  const scoped = evaluatorData.scoped_datasource_fields;
  if (scoped !== null && scoped !== undefined) scope.scoped_fields = captions(scoped);
  const matched = evaluatorData.semanticsearch_results;
  if (matched !== null && matched !== undefined) {
    scope.search_matches = Array.isArray(matched) ? captions(matched) : matched;
  }
  const all = evaluatorData.datasource_fields;
  if (all !== null && all !== undefined) {
    scope.datasource_field_count = Array.isArray(all) || typeof all === "string" ? all.length : all;
  }
  return scope;
}

/**
 * Convert a harness case + result into the row-payload used for the SSE `row`
 * event and SQLite persistence. Mirrors `_serialize_test_case`, including the
 * `user_friendly_reply` fold-in from `evaluator_data` (here the runner is
 * expected to have already folded it into `actual`, matching the ported
 * metrics-engine contract).
 */
export function serializeCase(c: HarnessCase, r: HarnessCaseResult): RowPayload {
  let actual: Record<string, unknown> = r.actual ?? {};
  // The palette runner keeps the requested palette type beside the answer; the
  // tool's palette judge needs it (sequential vs diverging rubric). Mirrors
  // `_serialize_test_case`'s paletteType fold-in.
  if (c.paletteType && actual && typeof actual === "object" && "colorPalette" in actual) {
    actual = { ...actual, paletteType: c.paletteType };
  }
  // Keep what the server told the model about the data: the fields its
  // search matched and the ones it scoped the question to. A run on
  // 2026-10-13 answered "the dataset has no such field" for fields that
  // exist, in time windows; without this record the cause (the server's
  // field search, the model, or the gateway) cannot be told apart.
  const debug: Record<string, unknown> = { ...(r.debugInfo ?? {}) };
  const scope = serverFieldScope(r.evaluatorData ?? {});
  if (Object.keys(scope).length) debug.server_field_scope = scope;
  return {
    test_case_id: c.id,
    runner: c.runner,
    datasource: c.datasource ?? null,
    utterance: c.utterance,
    turn: c.turn ?? 0,
    expected: c.expected ?? {},
    actual,
    latency: r.latency ?? null,
    errors: r.errors ?? [],
    metrics: r.metrics ?? {},
    debug_info: debug,
    info: r.info ?? {},
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface NlqOpaque {
  conversations: HarnessConversation[];
  runner: HarnessRunner;
}

/**
 * Options for constructing the adapter. The `harnessRunner` is the single seam
 * with no working-directory or credential-file coupling.
 */
export interface NlqAdapterOptions {
  harnessRunner: HarnessRunner;
  id?: string;
  harnessRunnerFactory?: () => HarnessRunner;
}

export class NlqEvaluatorAdapter implements EvalAdapter {
  readonly id: string;
  private readonly _runner: HarnessRunner;
  private readonly _runnerFactory?: () => HarnessRunner;

  constructor(opts: NlqAdapterOptions) {
    this.id = opts.id ?? "nlq";
    this._runner = opts.harnessRunner;
    this._runnerFactory = opts.harnessRunnerFactory;
  }

  /**
   * Lifecycle seam. It is
   * a no-op teardown handle, because the harness invocation is injected and
   * path-explicit. Kept so the orchestrator's session()/load()/execute()
   * ordering is unchanged.
   */
  session(_config: RunConfig, _jobId: string): AdapterSession {
    return {
      close() {
        /* no global state to restore — see module docstring */
      },
    };
  }

  async load(config: RunConfig): Promise<SuitePlan> {
    const runner = this._runnerFactory?.() ?? this._runner;
    const conversations = await runner.loadConversations(config);

    const total = conversations.reduce((n, conv) => n + conv.length, 0);
    if (total === 0) {
      throw new Error(
        "No runnable test cases found. " + "(NLQ harness returned no conversations)",
      );
    }

    const skeletons: CaseSkeleton[] = [];
    const conversation_ids: string[][] = [];
    for (const conversation of conversations) {
      conversation_ids.push(conversation.map((c) => c.id));
      for (const c of conversation) {
        skeletons.push(serializeSkeleton(c));
      }
    }

    const opaque: NlqOpaque = { conversations, runner };
    return { total, skeletons, conversation_ids, opaque };
  }

  async execute(
    plan: SuitePlan,
    config: RunConfig,
    emitCase: EmitCase,
    shouldStop: ShouldStop,
    completedIds: Set<string>,
  ): Promise<void> {
    const opaque = plan.opaque as NlqOpaque;
    const prefixes = Array.isArray(config.prefixes)
      ? (config.prefixes as unknown[]).map((p) => String(p))
      : [];
    const maxConcurrency = resolveMaxConcurrency(config);

    // Run one conversation, turn by turn (turns share nothing across the seam
    // here — the runner threads its own history by conversation id — but must
    // stay in order and stop promptly on a control request). Mirrors the
    const runConversation = async (conversation: HarnessConversation): Promise<void> => {
      for (const c of conversation) {
        if (shouldStop()) return;
        plan.case_started?.(c.id);
        const result = await opaque.runner.runCase(c, config, prefixes);
        await emitCase(serializeCase(c, result));
        if (shouldStop()) return;
      }
    };

    // Conversations run up to `maxConcurrency` at a time (bounded, in plan
    // order); turns inside a conversation stay sequential. This replaces the
    // strictly-sequential loop: the two problems
    // concurrency once caused are handled explicitly — a pause now lands
    // within about one case's latency because nothing new starts after the
    // control request, and the scattered 401s came from several requests
    // re-signing in at once, which the shared session now does only once per
    // lost token.
    await executeConversations(
      opaque.conversations,
      runConversation,
      shouldStop,
      completedIds,
      maxConcurrency,
    );
  }
}

/**
 * Run every conversation, at most `maxConcurrency` at a time, in order.
 * Conversations already complete (resume skip-list) are not started; once
 * `shouldStop` reports a control request nothing new starts, and the
 * conversations already in flight finish, so a pause lands within about one
 * case's latency. All tasks are drained before a runner exception is
 * re-raised, so no row is lost on the way out.
 */
export async function executeConversations(
  conversations: HarnessConversation[],
  runConversation: (conversation: HarnessConversation) => Promise<void>,
  shouldStop: ShouldStop,
  completedIds: Set<string>,
  maxConcurrency: number,
): Promise<void> {
  const limit = Math.max(1, Math.floor(maxConcurrency));
  let inFlight = 0;
  // Single-threaded event loop: a promise-chain semaphore serializes the gate.
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (inFlight < limit) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight += 1;
  };
  const release = (): void => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  const guarded = async (conversation: HarnessConversation): Promise<void> => {
    // Resume skip-list: skip a conversation only when EVERY one of its
    // case ids is already completed. Partial conversations were reset by the
    // orchestrator and re-run in full.
    if (
      conversation.length > 0 &&
      completedIds.size &&
      conversation.every((c) => completedIds.has(c.id))
    ) {
      return;
    }
    await acquire();
    try {
      if (shouldStop()) return;
      await runConversation(conversation);
    } finally {
      release();
    }
  };

  const tasks = conversations.map((conversation) => guarded(conversation));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") throw r.reason;
  }
}

/**
 * Factory + self-registration. The real harness runner is the native
 * TypeScript {@link NlqHarnessRunner} (src/harness/nlq_runner.ts): it loads
 * suite cases, posts to the CES conversations endpoint via a per-run
 * TableauSession built from the merged RunConfig, and scores each stage through
 * the ported metrics engine. It is constructed here with NO import-time
 * credential coupling — the session/ces/tls deps are all read from `config` at
 * runtime inside loadConversations/runCase.
 */
export function createNlqAdapter(opts: NlqAdapterOptions): NlqEvaluatorAdapter {
  return new NlqEvaluatorAdapter(opts);
}

register(new NlqEvaluatorAdapter({ harnessRunner: new NlqHarnessRunner() }));
// The standalone request paths share the native runner.
register(
  new NlqEvaluatorAdapter({
    id: "agent",
    harnessRunner: new NlqHarnessRunner(),
    harnessRunnerFactory: () => new NlqHarnessRunner(),
  }),
);
register(
  new NlqEvaluatorAdapter({
    id: "narratives",
    harnessRunner: new NlqHarnessRunner(),
    harnessRunnerFactory: () => new NlqHarnessRunner(),
  }),
);
