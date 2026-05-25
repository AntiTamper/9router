import { registerSession, unregisterSession, findPlugin } from "@/lib/mcp/stdioSseBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return new Response(`Unknown plugin: ${plugin}`, { status: 404 });
  }

  const encoder = new TextEncoder();
  let sid;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (sid) unregisterSession(plugin, sid);
    request.signal.removeEventListener("abort", cleanup);
  };

  request.signal.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      sid = registerSession(plugin, send);
      // MCP SSE handshake: tell client where to POST messages.
      send(`event: endpoint\ndata: /api/mcp/${plugin}/message?sessionId=${sid}\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
