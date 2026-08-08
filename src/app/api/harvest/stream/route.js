import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

const HARVEST_STREAM_URL = "http://127.0.0.1:3088/api/stream";
const KEEPALIVE_MS = 25_000;

export async function GET(request) {
  if (!await requireDashboardAuth(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const upstream = await fetch(HARVEST_STREAM_URL, {
    headers: { accept: "text/event-stream" },
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(`harvest stream unavailable (${upstream.status})`, { status: 502 });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          /* client gone */
        }
      }, KEEPALIVE_MS);

      const cleanup = () => {
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", cleanup);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(encoder.encode(decoder.decode(value, { stream: true })));
        }
      } catch (e) {
        /* upstream closed or aborted */
      } finally {
        cleanup();
        reader.releaseLock();
      }
    },
    cancel() {
      reader.cancel().catch(() => null);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
