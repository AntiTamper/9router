/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.added") {
    const idx = parsed.output_index ?? 0;
    state.items.set(idx, parsed.item || { type: "message", content: [], role: "assistant" });
  } else if (eventType === "response.output_text.delta") {
    const idx = parsed.output_index ?? 0;
    const text = parsed.delta?.text || "";
    if (text) {
      const item = state.items.get(idx) || { type: "message", content: [], role: "assistant" };
      const contentPart = item.content?.find(c => c.type === "output_text");
      if (contentPart) {
        contentPart.text = (contentPart.text || "") + text;
      } else {
        item.content = item.content || [];
        item.content.push({ type: "output_text", text: text });
      }
      state.items.set(idx, item);
    }
  } else if (eventType === "response.reasoning_summary_text.delta") {
    const idx = parsed.output_index ?? 0;
    const text = parsed.delta?.text || "";
    if (text) {
      const item = state.items.get(idx) || { type: "reasoning", summary: [] };
      const summaryPart = item.summary?.find(s => s.type === "summary_text");
      if (summaryPart) {
        summaryPart.text = (summaryPart.text || "") + text;
      } else {
        item.summary = item.summary || [];
        item.summary.push({ type: "summary_text", text: text });
      }
      state.items.set(idx, item);
    }
  } else if (eventType === "response.output_item.done") {
    const idx = parsed.output_index ?? 0;
    const existing = state.items.get(idx);
    const item = parsed.item || existing || { type: "message", content: [], role: "assistant" };
    // If done item has no content but we accumulated text, use accumulated
    if (parsed.item && existing?.content?.length > 0) {
      const hasParsedText = parsed.item.content?.some(c => c.type === "output_text" && c.text);
      if (!hasParsedText) {
        item.content = existing.content;
      }
    }
    state.items.set(idx, item);
  } else if (eventType === "response.completed") {
    state.status = "completed";
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
}
