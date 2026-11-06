# Run lifecycle and browser observation

## Ownership

`RunLifecycle` (`packages/core/src/run_lifecycle.ts`) is the commit boundary for
execution state, result persistence and browser changes. Routes submit control
commands; the orchestrator reports work. Neither the browser nor an adapter
decides whether an execution is authorized to write results.

Each logical run has a stable job id, a replaceable execution id and a monotonic
revision. Pause/cancel revoke the execution id before aborting work. Resume queues
a new execution. Late callbacks, errors and cleanup from the old execution cannot
commit. Abort saves resources; execution fencing provides correctness.

User pause preserves committed results and interrupts unfinished work. The serial
queue still awaits adapter/session teardown before starting another suite. Automatic
auth pauses request a boundary stop and drain existing work before settling paused.
Batch pause commits every active member before aborting the worker.

## Persistence

The existing results/metrics/errors tables remain authoritative result storage.
`run_observations` stores current lifecycle metadata and case definitions, not
duplicated result bodies. `runs` and `job_state` are compatibility projections
updated in the same transaction. Existing databases gain the observation tables
through additive `CREATE TABLE IF NOT EXISTS`; historical skeleton events are used
only to bootstrap definitions for pre-protocol runs.

A commit validates execution authority, writes results or retry invalidations,
applies the shared reducer, updates compatibility projections and appends a
revisioned `run_changes` record in one SQLite transaction. Notification follows
commit. Persistence failure rolls back the whole change rather than showing a row
that disappears on refresh.

Legacy `/events` remains available for existing clients and wire goldens. It is
not the new browser's lifecycle authority. Its terminal-event compatibility cleanup
does not affect `run_changes`.

## Observation

The browser shares one WebSocket (`/nlq-eval/observe`) across all observed runs
in a tab. Subscribe/unsubscribe commands carry a job id and a transport
subscription id; responses echo that subscription id so late messages from a
replaced subscription cannot update a store. HTTP still handles all lifecycle
commands. `GET /nlq-eval/observe/:job` remains available as a compatible
newline-delimited JSON transport. Both deliver:

1. Current snapshot at revision N, read consistently in a transaction.
2. Committed change-sets after N.
3. Further live changes and heartbeat objects (`{}`).

Pause does not close observation. Every refresh/reconnect starts from current
state, not the run's full history. Changes committed while the snapshot travels
are fetched after its revision, so the snapshot/live handoff has no gap. This is
current-state persistence with incremental synchronization, not full event sourcing.

The socket reads committed changes from SQLite after each snapshot's revision.
Backpressure disconnects a slow consumer rather than dropping revisions; reconnect
resubscribes every retained run with a current snapshot. Heartbeat loss triggers
bounded-backoff reconnect. A revision gap resubscribes only the affected run.

`@tableau-ai-eval/run-state` is browser-safe. Its pure `applyRunChange` reducer is used by
both server and browser. It ignores duplicate/old revisions and rejects identity
mismatches and revision gaps. A browser gap causes reconnection with a fresh
snapshot. Backend decisions and side effects do not run in the browser.

The frontend uses one reference-counted `RunObservationStore` per job. Selected
rows and sibling status/header views use those stores. Run-list polling discovers
membership and score/catalog metadata; it cannot roll observed lifecycle state
backward. Connection health is distinct from last-observed execution status.

Submitting feedback is local command UI state, outside the observation projection.
It never invents a lifecycle transition. Queued feedback explains worker availability
(including a previous execution still unwinding); preparation/publishing wording
comes from committed phase metadata. Reconnection explicitly labels the displayed
state as last confirmed rather than declaring the execution failed.

## Testing

- Shared reducer fixtures test lifecycle invariants without React or networking.
- Lifecycle tests verify rollback, execution fencing and equivalence between an
  applied change and a fresh snapshot.
- Route tests verify snapshot/live handoff, persistent observation through pause,
  and atomic batch pause before worker abort.
- Frontend fixtures feed snapshots/changes directly into stores. Transport tests
  cover refresh and tab identity independently of orchestration.

New lifecycle writes should go through `RunLifecycle`, not direct
`updateRunStatus`/`patchJobState` calls. Metadata such as score caches and stored
run identity is separate from execution lifecycle.
