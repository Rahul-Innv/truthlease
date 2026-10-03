/**
 * Server-sent events over the durable event table.
 *
 * On connect: `event: run.snapshot` with the full run, then every stored event
 * with seq > `after` as `event: run.event`. Then the store is polled every
 * 250 ms: new events are sent in order, followed by a fresh snapshot whenever
 * the run version changed (commands and job steps alike). A heartbeat comment
 * is sent every 15 s. When the demo is reset the stream follows the new
 * current run from seq 0. The stream closes when the client disconnects.
 *
 * Supabase (serverless) mode has no long-lived stream: this route answers one JSON
 * page `{run, events}` (events with seq > `after`, up to 500) after advancing a pending
 * job (work on read). The console polls it (NEXT_PUBLIC_CLEARING_TRANSPORT=poll). A
 * client whose `after` is ahead of the run's lastSeq (reset elsewhere) detects the new
 * run id in `run` and replays from 0.
 */
import { getService, isServerless, progressOnRead, rearmJob, withService } from "@/lib/app";
import { ValidationError } from "@/lib/service";
import { handle, json } from "../../../_lib/http";

export const dynamic = "force-dynamic";

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

function parseAfter(request: Request): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError("`after` must be a non-negative integer sequence number.", { after: raw }, "invalid_cursor");
  return n;
}

export async function GET(request: Request) {
  return handle(async () => {
    const after = parseAfter(request);
    if (isServerless()) {
      return withService(async (service) => {
        const run = await progressOnRead(service, await service.getOrCreateCurrent());
        return json({ run, events: service.listEvents(run.id, after, 500) });
      });
    }
    const service = await getService();
    const first = await service.getOrCreateCurrent();
    rearmJob(service, first);

    const encoder = new TextEncoder();
    let poll: ReturnType<typeof setInterval> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let runId = first.id;
        let lastSeq = after;
        let lastVersion = -1;

        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(poll);
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // already closed by the runtime
          }
        };
        const snapshot = () => {
          const run = service.getRun(runId);
          if (run && run.version !== lastVersion) {
            lastVersion = run.version;
            send(`event: run.snapshot\ndata: ${JSON.stringify(run)}\n\n`);
          }
        };
        const flushEvents = () => {
          for (;;) {
            const batch = service.listEvents(runId, lastSeq, 200);
            for (const e of batch) {
              send(`id: ${e.seq}\nevent: run.event\ndata: ${JSON.stringify(e)}\n\n`);
              lastSeq = e.seq;
            }
            if (batch.length < 200 || closed) break;
          }
        };
        const tick = () => {
          if (closed) return;
          try {
            const currentId = service.currentRunId();
            if (currentId && currentId !== runId) {
              // Demo reset: follow the new run from the beginning.
              runId = currentId;
              lastSeq = 0;
              lastVersion = -1;
              snapshot();
            }
            flushEvents();
            snapshot();
          } catch (err) {
            send(`: poll error ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}\n\n`);
          }
        };

        send("retry: 2000\n\n");
        snapshot();
        flushEvents();
        poll = setInterval(tick, POLL_MS);
        heartbeat = setInterval(() => send(`: heartbeat ${new Date().toISOString()}\n\n`), HEARTBEAT_MS);
        request.signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
