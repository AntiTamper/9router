import { describe, expect, it, vi } from "vitest";
import { createDisconnectAwareStream, createStreamController } from "open-sse/utils/streamHandler.js";

function makeFakeTransform(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  const readable = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
  const writer = { abort: () => Promise.resolve() };
  return { readable, writable: { getWriter: () => writer } };
}

async function drain(stream) {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("createDisconnectAwareStream finalize", () => {
  it("calls disconnect handler when the consumer cancels", async () => {
    const onDisconnect = vi.fn();
    const controller = createStreamController({ provider: "test", model: "m", onDisconnect });
    const fake = makeFakeTransform(["data: a\n\n", "data: b\n\n"]);

    const out = createDisconnectAwareStream(fake, controller, null);
    const reader = out.getReader();
    await reader.read();
    await reader.cancel("client_closed");

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect.mock.calls[0][0]).toMatchObject({ reason: "client_closed" });
  });

  it("does not call disconnect handler on natural EOF", async () => {
    const onDisconnect = vi.fn();
    const controller = createStreamController({ provider: "test", model: "m", onDisconnect });
    const fake = makeFakeTransform(["data: a\n\n"]);

    const out = createDisconnectAwareStream(fake, controller, null);
    await drain(out);

    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("tolerates a missing terminal callback", async () => {
    const controller = createStreamController({ provider: "test", model: "m" });
    const fake = makeFakeTransform(["data: a\n\n"]);
    const out = createDisconnectAwareStream(fake, controller, null);
    await expect(drain(out)).resolves.toBeUndefined();
  });
});
