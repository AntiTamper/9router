import { describe, expect, it, vi } from "vitest";
import { createDisconnectAwareStream, createStreamController } from "open-sse/utils/streamHandler.js";

function makeFakeTransform(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  const readable = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
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
  it("calls finalize when the consumer cancels (short request / client close)", async () => {
    const onFinalize = vi.fn();
    const controller = createStreamController({ provider: "test", model: "m" });
    const fake = makeFakeTransform(["data: a\n\n", "data: b\n\n"]);

    const out = createDisconnectAwareStream(fake, controller, onFinalize);
    const reader = out.getReader();
    await reader.read();
    await reader.cancel("client_closed");

    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(onFinalize).toHaveBeenCalledWith("client_closed");
  });

  it("does not call finalize on natural EOF (flush path handles it)", async () => {
    const onFinalize = vi.fn();
    const controller = createStreamController({ provider: "test", model: "m" });
    const fake = makeFakeTransform(["data: a\n\n"]);

    const out = createDisconnectAwareStream(fake, controller, onFinalize);
    await drain(out);

    expect(onFinalize).not.toHaveBeenCalled();
  });

  it("tolerates a missing finalize callback", async () => {
    const controller = createStreamController({ provider: "test", model: "m" });
    const fake = makeFakeTransform(["data: a\n\n"]);
    const out = createDisconnectAwareStream(fake, controller, null);
    await expect(drain(out)).resolves.toBeUndefined();
  });
});