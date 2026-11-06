import type { ObservationCommand, RunChange, RunProjection, RunSnapshot } from '@tableau-ai-eval/run-state';

/** Deterministic browser transport fixture; never opens a network connection. */
export function mockObservationSocket(snapshot: (jobId: string) => RunProjection) {
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    commands: ObservationCommand[] = [];
    subscriptions = new Map<string, string>();
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
    }
    send(raw: string) {
      const command = JSON.parse(raw) as ObservationCommand;
      this.commands.push(command);
      if (command.type === 'unsubscribe') {
        if (this.subscriptions.get(command.jobId) === command.subscriptionId) this.subscriptions.delete(command.jobId);
      } else {
        this.subscriptions.set(command.jobId, command.subscriptionId);
        queueMicrotask(() => this.deliver(command.subscriptionId, { type: 'snapshot', projection: snapshot(command.jobId) }));
      }
    }
    deliver(subscriptionId: string, message: RunChange | RunSnapshot) {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ subscriptionId, message }) });
    }
    change(message: RunChange) {
      const id = this.subscriptions.get(message.jobId);
      if (id) this.deliver(id, message);
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  return { sockets, restore() { sockets.forEach(s => s.close()); globalThis.WebSocket = original; } };
}
