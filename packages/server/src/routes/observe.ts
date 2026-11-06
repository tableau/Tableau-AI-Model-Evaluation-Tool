import { unknownJob, type RoutesContext } from "./context.ts";

/** Fresh snapshot + committed changes. Pause does not end observation.
 * Snapshot/cursor are read synchronously in one transaction; all later
 * revisions are durable, including commits while the snapshot is transmitted.
 */
export function observeRun(ctx: RoutesContext, jobId: string, req: Request): Response {
  const snapshot = ctx.lifecycle.snapshot(jobId);
  if (!snapshot) return unknownJob();
  const encoder = new TextEncoder();
  let cancelled = false;
  const abort = () => { cancelled = true; ctx.sse.notifier.notifyAll(); };
  req.signal.addEventListener("abort", abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let revision = snapshot.revision;
      const send = (data: unknown) => controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      try {
        send({ type: "snapshot", projection: snapshot });
        while (!cancelled && !req.signal.aborted) {
          const changes = ctx.lifecycle.changes(jobId, revision);
          for (const change of changes) { send(change); revision = change.revision; }
          if (!ctx.db.getRun(jobId)) break;
          await ctx.sse.notifier.wait(1000);
          if (!cancelled && !req.signal.aborted && !ctx.lifecycle.changes(jobId, revision).length) send({});
        }
      } catch {
        // Consumer disconnect; committed changes remain available to others.
      } finally {
        req.signal.removeEventListener("abort", abort);
        try { controller.close(); } catch { /* cancelled reader */ }
      }
    },
    cancel() { abort(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
