// Caveman injector: appends a terse-output instruction into the system message
// just before dispatch. Idempotent across levels so settings can change mid-session.

import { FORMATS } from "../translator/formats.js";
import { CAVEMAN_PROMPTS } from "./cavemanPrompts.js";

const SEP = "\n\n";
const PROMPTS = Object.values(CAVEMAN_PROMPTS);

export function injectCaveman(body, format, level) {
  const prompt = CAVEMAN_PROMPTS[level];
  if (!body || !prompt) return;

  switch (format) {
    case FORMATS.CLAUDE:
      injectClaudeSystem(body, prompt);
      return;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
    case FORMATS.ANTIGRAVITY:
      injectGeminiSystem(body, prompt);
      return;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      injectMessagesSystem(body, prompt, "input_text");
      return;
    default:
      injectMessagesSystem(body, prompt, "text");
  }
}

function stripPromptText(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const prompt of PROMPTS) {
    out = out.split(SEP + prompt).join("");
    out = out.split(prompt + SEP).join("");
    out = out.split(prompt).join("");
  }
  return out;
}

function isPromptText(text) {
  return PROMPTS.includes(text);
}

function cleanPartArray(parts) {
  if (!Array.isArray(parts)) return parts;
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return part;
      if (typeof part.text === "string") {
        const text = stripPromptText(part.text);
        if (!text.trim()) return null;
        return { ...part, text };
      }
      return part;
    })
    .filter(Boolean);
}

function injectMessagesSystem(body, prompt, partType) {
  if (typeof body.instructions === "string") {
    const base = stripPromptText(body.instructions).trim();
    body.instructions = base ? base + SEP + prompt : prompt;
    return;
  }

  const arr = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!arr) return;

  const idx = arr.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
  if (idx >= 0) {
    appendToOpenAIMessage(arr[idx], prompt, partType);
  } else {
    const content = partType === "input_text" ? [{ type: "input_text", text: prompt }] : prompt;
    arr.unshift({ role: "system", content });
  }
}

function appendToOpenAIMessage(msg, prompt, partType) {
  if (typeof msg.content === "string") {
    const base = stripPromptText(msg.content).trim();
    msg.content = base ? base + SEP + prompt : prompt;
  } else if (Array.isArray(msg.content)) {
    msg.content = cleanPartArray(msg.content);
    msg.content.push({ type: partType, text: prompt });
  } else {
    msg.content = partType === "input_text" ? [{ type: "input_text", text: prompt }] : prompt;
  }
}

function injectClaudeSystem(body, prompt) {
  if (typeof body.system === "string" && body.system.length > 0) {
    const base = stripPromptText(body.system).trim();
    body.system = base ? base + SEP + prompt : prompt;
    return;
  }
  if (Array.isArray(body.system)) {
    body.system = body.system.filter((block) => !(block?.type === "text" && isPromptText(block.text)));
    for (const block of body.system) {
      if (block?.type === "text" && typeof block.text === "string") block.text = stripPromptText(block.text);
    }
    const block = { type: "text", text: prompt };
    let lastCacheIdx = -1;
    for (let i = body.system.length - 1; i >= 0; i--) {
      if (body.system[i]?.cache_control) { lastCacheIdx = i; break; }
    }
    if (lastCacheIdx >= 0) body.system.splice(lastCacheIdx, 0, block);
    else body.system.push(block);
    return;
  }
  body.system = prompt;
}

function injectGeminiSystem(body, prompt) {
  const target = body.request && typeof body.request === "object" ? body.request : body;
  const useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction");
  const key = useSnake ? "system_instruction" : "systemInstruction";
  const sys = target[key];
  if (sys && Array.isArray(sys.parts)) {
    sys.parts = sys.parts
      .map((part) => typeof part?.text === "string" ? { ...part, text: stripPromptText(part.text) } : part)
      .filter((part) => !(typeof part?.text === "string" && !part.text.trim()));
    sys.parts.push({ text: prompt });
    return;
  }
  target[key] = { parts: [{ text: prompt }] };
}
