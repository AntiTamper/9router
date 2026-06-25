import { describe, expect, it } from "vitest";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";

function makeStream(events) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      const data = `event: ${events[i].event}\ndata: ${JSON.stringify(events[i].data)}\n\n`;
      controller.enqueue(encoder.encode(data));
      i++;
    }
  });
}

describe("streamToJsonConverter", () => {
  it("preserves both reasoning and message items by item_id", async () => {
    const events = [
      { event: "response.created", data: { response: { id: "resp_123", created_at: 1234567890 } } },
      { event: "response.output_item.added", data: { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } } },
      { event: "response.output_item.added", data: { output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } } },
      { event: "response.reasoning_summary_text.delta", data: { item_id: "rs_1", output_index: 0, delta: { text: "thinking..." } } },
      { event: "response.output_text.delta", data: { item_id: "msg_1", output_index: 0, delta: { text: "hello world" } } },
      { event: "response.output_item.done", data: { item_id: "rs_1", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } } },
      { event: "response.output_item.done", data: { item_id: "msg_1", output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } } },
      { event: "response.completed", data: { response: { usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } } }
    ];

    const result = await convertResponsesStreamToJson(makeStream(events));

    expect(result.output.length).toBe(2);
    expect(result.output[0]).toEqual({ id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] });
    expect(result.output[1]).toEqual({ id: "msg_1", type: "message", content: [{ type: "output_text", text: "hello world" }], role: "assistant" });
  });

  it("merges accumulated content into done item if done item lacks it", async () => {
    const events = [
      { event: "response.created", data: { response: { id: "resp_123", created_at: 1234567890 } } },
      { event: "response.output_item.added", data: { output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } } },
      { event: "response.output_text.delta", data: { item_id: "msg_1", output_index: 0, delta: { text: "accumulated text" } } },
      { event: "response.output_item.done", data: { item_id: "msg_1", output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } } },
      { event: "response.completed", data: { response: { usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } } }
    ];

    const result = await convertResponsesStreamToJson(makeStream(events));

    expect(result.output.length).toBe(1);
    expect(result.output[0].content).toEqual([{ type: "output_text", text: "accumulated text" }]);
  });

  it("does not overwrite done item content that already has text", async () => {
    const events = [
      { event: "response.created", data: { response: { id: "resp_123", created_at: 1234567890 } } },
      { event: "response.output_item.added", data: { output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } } },
      { event: "response.output_text.delta", data: { item_id: "msg_1", output_index: 0, delta: { text: "delta text" } } },
      { event: "response.output_item.done", data: { item_id: "msg_1", output_index: 0, item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "done text" }], role: "assistant" } } },
      { event: "response.completed", data: { response: { usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } } }
    ];

    const result = await convertResponsesStreamToJson(makeStream(events));

    expect(result.output.length).toBe(1);
    expect(result.output[0].content).toEqual([{ type: "output_text", text: "done text" }]);
  });
});
