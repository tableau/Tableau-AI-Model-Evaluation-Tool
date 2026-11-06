import { API_BASE } from './api';
import type { ObservationCommand, ObservationMessage, RunChange, RunSnapshot } from '@tableau-ai-eval/run-state';

interface Subscription {
  id: string;
  receive: (message: RunSnapshot | RunChange) => void;
  health: (state: 'reconnecting' | 'error', error?: string) => void;
  snapshotReceived: boolean;
}

/** One connection per tab. Run stores retain authority over their own projections. */
export class ObservationTransport {
  private subscriptions = new Map<string, Subscription>();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private serial = 0;

  constructor(private createSocket = (url: string) => new WebSocket(url)) {}

  subscribe(jobId: string, receive: Subscription['receive'], health: Subscription['health']) {
    const subscription = { id: String(++this.serial), receive, health, snapshotReceived: false };
    this.subscriptions.set(jobId, subscription);
    if (this.socket?.readyState === 1) this.send(jobId, subscription, 'subscribe');
    else this.connect();
    return () => {
      if (this.subscriptions.get(jobId) !== subscription) return;
      this.send(jobId, subscription, 'unsubscribe');
      this.subscriptions.delete(jobId);
      if (!this.subscriptions.size) this.dispose();
    };
  }

  private send(jobId: string, subscription: Subscription, type: ObservationCommand['type']) {
    if (this.socket?.readyState === 1)
      this.socket.send(JSON.stringify({ type, jobId, subscriptionId: subscription.id } satisfies ObservationCommand));
  }

  private watchdog(ms: number) {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.disconnect(), ms);
  }

  private connect() {
    if (this.socket || this.retry || !this.subscriptions.size) return;
    const url = new URL(`${API_BASE}/nlq-eval/observe`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try { socket = this.createSocket(url.href); } catch { this.disconnect(); return; }
    this.socket = socket;
    this.watchdog(20000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.watchdog(30000);
      for (const [jobId, subscription] of this.subscriptions) {
        subscription.snapshotReceived = false;
        subscription.id = String(++this.serial);
        this.send(jobId, subscription, 'subscribe');
      }
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      this.watchdog(30000);
      try {
        const envelope = JSON.parse(String(event.data)) as ObservationMessage;
        if ('type' in envelope && envelope.type === 'heartbeat') return;
        if (!('subscriptionId' in envelope)) throw new Error('Invalid observation message');
        const entry = [...this.subscriptions].find(([, s]) => s.id === envelope.subscriptionId);
        if (!entry) return; // Old subscription, including events already in transit.
        const [jobId, subscription] = entry;
        if ('error' in envelope) {
          subscription.health('error', envelope.error);
          this.send(jobId, subscription, 'unsubscribe');
          this.subscriptions.delete(jobId);
          if (!this.subscriptions.size) this.dispose();
          return;
        }
        try {
          if (!subscription.snapshotReceived && envelope.message.type !== 'snapshot')
            throw new Error('Missing initial snapshot');
          subscription.receive(envelope.message);
          subscription.snapshotReceived = true;
          this.attempt = 0;
        } catch {
          // A gap only resubscribes this run, not all the other stores.
          subscription.health('reconnecting');
          subscription.snapshotReceived = false;
          subscription.id = String(++this.serial);
          this.send(jobId, subscription, 'subscribe');
        }
      } catch { this.disconnect(); }
    };
    socket.onerror = socket.onclose = () => { if (this.socket === socket) this.disconnect(); };
  }

  private disconnect() {
    clearTimeout(this.deadline);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    if (!this.subscriptions.size || this.retry) return;
    this.attempt += 1;
    for (const subscription of this.subscriptions.values()) subscription.health('reconnecting');
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); },
      Math.min(1000 * 2 ** Math.min(this.attempt - 1, 4), 15000));
  }

  private dispose() {
    clearTimeout(this.retry); this.retry = undefined;
    clearTimeout(this.deadline);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.attempt = 0;
  }
}

export const observationTransport = new ObservationTransport();
