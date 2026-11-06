import { applyRunChange, type ObservedCase, type ObservedResult, type ObservedRun,
  type RunChange, type RunProjection, type RunStatus } from "@tableau-ai-eval/run-state";
import type { AiEvalDb } from "./db/index.ts";
import type { SseState } from "./sse/state.ts";

/** Sole commit boundary for lifecycle, result writes and browser notifications.
 * SQLite is current state; the change log only bridges snapshot/live delivery.
 * Legacy state/records are compatibility projections written in the same tx.
 */
export class RunLifecycle {
  constructor(private db: AiEvalDb, private sse: SseState) {}

  snapshot(jobId: string): RunProjection | null {
    return this.db.db.transaction(() => this.read(jobId))();
  }

  private read(jobId: string, includeResults = true): RunProjection | null {
    const storedRun = this.db.getRun(jobId);
    let data = includeResults ? this.db.getFullResults(jobId)
      : storedRun ? { run: storedRun, results: [], metrics: [], errors: [] } : null;
    if (!data) {
      const state = this.db.getJobState(jobId);
      if (!state.status) return null;
      data = { run: { ...state, config: {} }, results: [], metrics: [], errors: [] };
    }
    const saved = this.db.db.query<{ projection: string }, [string]>(
      "SELECT projection FROM run_observations WHERE job_id = ?",
    ).get(jobId);
    const state = this.db.getJobState(jobId);
    const run = { ...data.run, job_id: jobId,
      status: state.status || data.run.status || "queued",
      total: Number(state.total ?? data.run.total ?? 0),
      completed: Number(state.completed ?? data.run.completed ?? 0),
      config: data.run.config ?? {},
    } as ObservedRun;
    const results: Record<string, ObservedResult> = {};
    const metricMap = new Map<string, ObservedResult["metrics"]>();
    for (const m of data.metrics) {
      let stages = metricMap.get(m.test_case_id);
      if (!stages) { stages = {}; metricMap.set(m.test_case_id, stages); }
      stages[m.stage] ??= [];
      stages[m.stage].push({ metric_id: m.metric_id ?? "", metric_name: m.metric_name,
        score: m.score, explanation: m.explanation ?? null });
    }
    const errorMap = new Map<string, ObservedResult["errors"]>();
    for (const e of data.errors) {
      const errors = errorMap.get(e.test_case_id) ?? [];
      errors.push({ phase: e.phase ?? "", description: e.description ?? "", warning: Boolean(e.is_warning) });
      errorMap.set(e.test_case_id, errors);
    }
    for (const r of data.results) {
      results[r.test_case_id] = {
        test_case_id: r.test_case_id, runner: r.runner ?? "", datasource: r.datasource ?? null,
        utterance: r.utterance ?? "", expected: r.expected ?? null, actual: r.actual ?? null,
        latency: typeof r.latency === "number" ? r.latency : null,
        metrics: metricMap.get(r.test_case_id) ?? {}, errors: errorMap.get(r.test_case_id) ?? [],
        debug_info: r.debug_info ?? null, info: r.info ?? null,
      };
    }
    if (saved) {
      const projection = JSON.parse(saved.projection) as RunProjection;
      // Config/score metadata may be enriched independently; lifecycle never is.
      return { ...projection, run: { ...run, ...projection.run, config: run.config },
        state: { ...state, ...projection.state }, results };
    }
    // One-time compatibility bootstrap for databases created before this protocol.
    const cases = this.db.getEvents(jobId, 0, ["skeletons"]).flatMap(e => {
      const event = JSON.parse(e.payload) as { items?: ObservedCase[] };
      return event.items ?? [];
    });
    return { jobId, revision: 0, executionId: "", run, state, cases, results,
      runningIds: run.status === "started" ? (state.running_case_ids as string[] ?? []) : [],
      retryingIds: state.retrying_case_ids as string[] ?? [] };
  }

  /** Return null for a revoked execution; its result AND all effects are discarded. */
  commit(jobId: string, change: Omit<RunChange, "type" | "jobId" | "revision" | "executionId">,
    options: { executionId?: string; nextExecutionId?: string; control?: string | null;
      write?: () => void; notify?: boolean } = {}): RunChange | null {
    const event = this.db.db.transaction(() => {
      const current = this.read(jobId, false);
      if (!current || (options.executionId !== undefined &&
        (options.executionId !== current.executionId || current.run.status !== "started"))) return null;
      const event: RunChange = { ...change, type: "change", jobId, revision: current.revision + 1,
        executionId: options.nextExecutionId ?? current.executionId };
      if (event.run?.status && !["queued", "started"].includes(event.run.status)) {
        event.state = { ...event.state, phase: null };
        event.runningIds = [];
      }
      options.write?.();
      const next = applyRunChange(current, event);
      this.db.updateRunStatus(jobId, next.run.status, {
        completed: next.run.completed, total: next.run.total,
        error: typeof next.run.error === "string" ? next.run.error : "",
      });
      this.db.patchJobState(jobId, next.state);
      if ("control" in options) this.db.setJobControl(jobId, options.control ?? null);
      // Result bodies remain in their existing tables, not duplicated in a JSON blob.
      this.db.db.query("INSERT INTO run_observations (job_id, projection) VALUES (?, ?) " +
        "ON CONFLICT(job_id) DO UPDATE SET projection = excluded.projection")
        .run(jobId, JSON.stringify({ ...next, results: {} }));
      this.db.db.query("INSERT INTO run_changes (job_id, revision, payload) VALUES (?, ?, ?)")
        .run(jobId, event.revision, JSON.stringify(event));
      return event;
    })();
    if (event && options.notify !== false) this.sse.notifier.notifyAll();
    return event;
  }

  patch(jobId: string, patch: Record<string, unknown>, executionId?: string): RunChange | null {
    const run: Partial<ObservedRun> = {};
    for (const key of ["status", "completed", "total", "error"] as const) {
      if (key in patch) Object.assign(run, { [key]: patch[key] });
    }
    return this.commit(jobId, { run, state: patch,
      ...(Array.isArray(patch.running_case_ids) ? { runningIds: patch.running_case_ids as string[] } : {}),
      ...(Array.isArray(patch.retrying_case_ids) ? { retryingIds: patch.retrying_case_ids as string[] } : {}),
    }, { executionId });
  }

  begin(jobId: string): string | null {
    const current = this.read(jobId, false);
    if (!current || current.run.status !== "queued" || this.db.getJobControl(jobId)) return null;
    const executionId = crypto.randomUUID();
    return this.commit(jobId, { run: { status: "started" }, state: { phase: "Preparing evaluation" },
      runningIds: [] }, { nextExecutionId: executionId }) ? executionId : null;
  }

  stop(jobId: string, status: "paused" | "cancelled", notify = true): RunChange | null {
    const current = this.read(jobId, false);
    if (!current) return null;
    if (status === "paused" && !["queued", "started"].includes(current.run.status)) return null;
    if (status === "cancelled" && ["finished", "failed", "cancelled"].includes(current.run.status)) return null;
    return this.commit(jobId, { run: { status }, state: { phase: null }, runningIds: [] },
      { nextExecutionId: crypto.randomUUID(), control: status === "paused" ? "pause" : "cancel", notify });
  }

  resume(jobId: string): RunChange | null {
    const current = this.read(jobId, false);
    if (!current || !(current.run.status === "paused" ||
      current.run.status === "failed" && current.run.completed < current.run.total ||
      current.run.status === "finished" && Number(current.state.failed_cases) > 0)) return null;
    return this.commit(jobId, { run: { status: "queued", error: null }, state: { error: null, phase: null },
      runningIds: [] }, { nextExecutionId: crypto.randomUUID(), control: null });
  }

  changes(jobId: string, revision: number): RunChange[] {
    return this.db.db.query<{ payload: string }, [string, number]>(
      "SELECT payload FROM run_changes WHERE job_id = ? AND revision > ? ORDER BY revision",
    ).all(jobId, revision).map(row => JSON.parse(row.payload) as RunChange);
  }

  status(jobId: string): RunStatus | undefined { return this.read(jobId, false)?.run.status; }

  metadata(jobId: string): Pick<RunProjection, "run" | "state" | "revision"> | null {
    const projection = this.read(jobId, false);
    return projection ? { run: projection.run, state: projection.state, revision: projection.revision } : null;
  }

  owns(jobId: string, executionId: string): boolean {
    const current = this.read(jobId, false);
    return current?.executionId === executionId && current.run.status === "started";
  }

  /** Automatic pause drains current work; user pause revokes it immediately. */
  requestPause(jobId: string, reason: string, executionId?: string): RunChange | null {
    return this.commit(jobId, { state: { pause_reason: reason } }, { executionId, control: "pause" });
  }
}
