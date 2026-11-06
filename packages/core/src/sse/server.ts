/**
 * Minimal SSE HTTP endpoint on `Bun.serve`: the
 * `text/event-stream` route for live run tailing.
 *
 * Route: GET /nlq-eval/events/:job_id?after=<id>
 * Emits: `id: <seq>\ndata: <compact-json>\n\n` per event, plus periodic
 *        heartbeat comments to keep proxies from closing idle connections.
 */

import type { Server } from "bun";
import type { SseState } from "./state.ts";
import { toSseFrame } from "./state.ts";

export interface SseServerOptions {
  port?: number;
  /** event types that close the stream once seen */
  terminalTypes?: string[];
  /** idle poll interval / heartbeat cadence (ms) */
  pollMs?: number;
}

export function startSseServer(
  state: SseState,
  opts: SseServerOptions = {},
): Server<undefined> {
  const pollMs = opts.pollMs ?? 15000;

  return Bun.serve({
    port: opts.port ?? 0, // 0 => OS-assigned free port
    async fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/nlq-eval\/events\/([^/]+)$/);
      if (req.method !== "GET" || !match) {
        return new Response("Not Found", { status: 404 });
      }
      const jobId = decodeURIComponent(match[1]);
      const afterId = Number(url.searchParams.get("after") ?? "0") || 0;

      const encoder = new TextEncoder();
      const controller = new AbortController();
      req.signal.addEventListener("abort", () => controller.abort());

      const stream = new ReadableStream({
        async start(ctrl) {
          try {
            for await (const ev of state.streamEvents(jobId, {
              afterId,
              signal: controller.signal,
              terminalTypes: opts.terminalTypes,
              pollMs,
            })) {
              ctrl.enqueue(encoder.encode(toSseFrame(ev)));
            }
          } catch (err) {
            // client abort or stream error — close quietly
          } finally {
            try {
              ctrl.close();
            } catch {}
          }
        },
        cancel() {
          controller.abort();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  });
}
