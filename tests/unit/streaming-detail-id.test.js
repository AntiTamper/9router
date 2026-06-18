import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestUsageBatch: vi.fn(() => Promise.resolve()),
}));
vi.mock("open-sse/utils/streamHandler.js", () => ({
  pipeWithDisconnect: vi.fn(() => new ReadableStream({ start(c) { c.close(); } })),
}));

import { saveRequestDetail } from "@/lib/usageDb.js";
import { handleStreamingResponse, buildOnStreamComplete } from "open-sse/handlers/chatCore/streamingHandler.js";

describe("streaming request-detail id reuse (no stuck placeholder)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("placeholder and finalize use the SAME id so the finalize upserts the placeholder row", async () => {
    const ctx = {
      provider: "claude",
      model: "claude-opus",
      connectionId: "conn-1",
      apiKey: "k",
      requestStartTime: Date.now(),
      body: { messages: [{ role: "user", content: "hi" }], model: "claude-opus" },
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: { endpoint: "/v1/messages" },
    };

    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);
    expect(streamDetailId).toBeTruthy();

    // Placeholder write
    handleStreamingResponse({
      ...ctx,
      providerResponse: new ReadableStream({ start(c) { c.close(); } }),
      sourceFormat: "claude",
      targetFormat: "claude",
      streamController: { signal: undefined },
      onStreamComplete,
      streamDetailId,
    });

    // Finalize write
    onStreamComplete({ content: "hello world", thinking: null }, { prompt_tokens: 10, completion_tokens: 5 }, Date.now());

    expect(saveRequestDetail).toHaveBeenCalledTimes(2);
    const placeholderId = saveRequestDetail.mock.calls[0][0].id;
    const finalizeId = saveRequestDetail.mock.calls[1][0].id;
    expect(placeholderId).toBe(streamDetailId);
    expect(finalizeId).toBe(streamDetailId);
    expect(placeholderId).toBe(finalizeId);

    // Finalize carries real tokens + content (not the placeholder).
    const finalDetail = saveRequestDetail.mock.calls[1][0];
    expect(finalDetail.tokens.completion_tokens).toBe(5);
    expect(finalDetail.providerResponse).toBe("hello world");
  });
});
