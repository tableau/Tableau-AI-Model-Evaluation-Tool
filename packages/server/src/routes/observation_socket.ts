import type { ServerWebSocket } from "bun";
import { RunLifecycle, type AiEvalDb, type SseState } from "@tableau-ai-eval/core";
import type { ObservationCommand, ObservationMessage } from "@tableau-ai-eval/run-state";

export interface ObservationSocketData {
  subscriptions: Map<string, { subscriptionId: string; revision: number }>;
  closed: boolean;
}

/** Notification is only a wakeup: every delivered change is read from SQLite. */
export function observationSocket(db: AiEvalDb, sse: SseState) {
  const lifecycle = new RunLifecycle(db, sse);
  const send = (ws: ServerWebSocket<ObservationSocketData>, message: ObservationMessage): boolean => {
    if (ws.data.closed) return false;
    // Bun's send: the bytes written, -1 for a message queued under
    // backpressure (still delivered), 0 for a message dropped. Only a drop
    // ends the subscription: never skip an individual revision, and a
    // reconnect recovers a fresh snapshot. A snapshot of a large run is
    // queued (-1) on every connection, which must not count as too slow.
    if (ws.send(JSON.stringify(message)) === 0) {
      ws.data.closed = true;
      ws.close(1013, "Observation consumer too slow");
      return false;
    }
    return true;
  };
  return {
    maxPayloadLength: 16384,
    // A run's snapshot is one message, and a full Build a visualization run
    // with its results is well over 4 MB; the queue has to hold one of those.
    backpressureLimit: 64 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    async open(ws: ServerWebSocket<ObservationSocketData>) {
      try {
        while (!ws.data.closed) {
          for (const [jobId, subscription] of ws.data.subscriptions) {
            if (!db.getRun(jobId)) {
              send(ws, { subscriptionId: subscription.subscriptionId, error: "This evaluation was deleted." });
              ws.data.subscriptions.delete(jobId);
              continue;
            }
            for (const message of lifecycle.changes(jobId, subscription.revision)) {
              if (!send(ws, { subscriptionId: subscription.subscriptionId, message })) return;
              subscription.revision = message.revision;
            }
          }
          await sse.notifier.wait(1000);
          if (!send(ws, { type: "heartbeat" })) return;
        }
      } catch {
        ws.close(1011, "Observation unavailable");
      }
    },
    message(ws: ServerWebSocket<ObservationSocketData>, raw: string | Buffer) {
      let command: ObservationCommand;
      try { command = JSON.parse(String(raw)); } catch { ws.close(1008, "Invalid subscription"); return; }
      if (!command || typeof command.jobId !== "string" || typeof command.subscriptionId !== "string" ||
        !command.jobId || !command.subscriptionId || !["subscribe", "unsubscribe"].includes(command.type)) {
        ws.close(1008, "Invalid subscription"); return;
      }
      if (command.type === "unsubscribe") {
        if (ws.data.subscriptions.get(command.jobId)?.subscriptionId === command.subscriptionId)
          ws.data.subscriptions.delete(command.jobId);
        return;
      }
      if (ws.data.subscriptions.size >= 200 && !ws.data.subscriptions.has(command.jobId)) {
        send(ws, { subscriptionId: command.subscriptionId, error: "Too many observation subscriptions." }); return;
      }
      const projection = lifecycle.snapshot(command.jobId);
      if (!projection) {
        send(ws, { subscriptionId: command.subscriptionId, error: "No evaluation with this id exists." }); return;
      }
      // Snapshot and cursor registration are synchronous. Commits during delivery
      // are fetched after this revision by the pump, without a live handoff gap.
      ws.data.subscriptions.set(command.jobId, { subscriptionId: command.subscriptionId, revision: projection.revision });
      send(ws, { subscriptionId: command.subscriptionId, message: { type: "snapshot", projection } });
      sse.notifier.notifyAll();
    },
    close(ws: ServerWebSocket<ObservationSocketData>) {
      ws.data.closed = true;
      ws.data.subscriptions.clear();
      sse.notifier.notifyAll();
    },
  };
}
