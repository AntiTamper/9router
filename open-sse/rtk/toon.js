// TOON: lossless JSON to compact tabular notation for tool results.
import { encode } from "@toon-format/toon";
import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";

export function tryToon(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  try {
    const toon = encode(parsed, { indent: 2 });
    if (toon && toon.length > 0 && toon.length < trimmed.length) return toon;
  } catch {
    // Ignore encoder failures; callers keep the original text.
  }
  return null;
}

export function applyToon(body, enabled) {
  if (!enabled || !body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return applyToonKiroFormat(body);
  }

  const items = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (const msg of items) {
      if (!msg) continue;

      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressTextToon(msg.output, stats, "openai-responses-string");
        } else if (Array.isArray(msg.output)) {
          for (const part of msg.output) {
            if (part?.type === "input_text" && typeof part.text === "string") {
              part.text = compressTextToon(part.text, stats, "openai-responses-array");
            }
          }
        }
        continue;
      }

      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressTextToon(msg.content, stats, "openai-tool");
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      if (msg.role === "tool") {
        for (const part of msg.content) {
          if (part?.type === "text" && typeof part.text === "string") {
            part.text = compressTextToon(part.text, stats, "openai-tool-array");
          }
        }
        continue;
      }

      for (const block of msg.content) {
        if (!block || block.type !== "tool_result" || block.is_error === true) continue;
        if (typeof block.content === "string") {
          block.content = compressTextToon(block.content, stats, "claude-string");
        } else if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part?.type === "text" && typeof part.text === "string") {
              part.text = compressTextToon(part.text, stats, "claude-array");
            }
          }
        }
      }
    }
  } catch (error) {
    console.warn("[TOON] applyToon error:", error?.message || error);
    return null;
  }

  return stats;
}

function compressTextToon(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const out = tryToon(text);
  if (out && out.length > 0 && out.length < bytesIn) {
    stats.bytesAfter += out.length;
    stats.hits.push({ shape, filter: "toon", saved: bytesIn - out.length });
    return out;
  }

  stats.bytesAfter += bytesIn;
  return text;
}

function applyToonKiroFormat(body) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);
    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;
      for (const tr of toolResults) {
        if (tr.status === "error") continue;
        if (!Array.isArray(tr.content)) continue;
        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressTextToon(part.text, stats, "kiro-tool-result");
          }
        }
      }
    }
  } catch (error) {
    console.warn("[TOON] applyToonKiroFormat error:", error?.message || error);
    return null;
  }
  return stats;
}

export function formatToonLog(stats) {
  if (!stats?.hits?.length) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  return `[TOON] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) hits=${stats.hits.length}`;
}
