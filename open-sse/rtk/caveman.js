// Caveman injector: appends a caveman-style instruction into the system message
// of the final request body, just before it is dispatched to the provider executor.
// Dispatches by format so it works for both translated and native-passthrough flows.

import { FORMATS } from "../translator/formats.js";
import { CAVEMAN_PROMPTS } from "./cavemanPrompts.js";

const SEP = "\n\n";
const CAVEMAN_PROMPT_SET = new Set(Object.values(CAVEMAN_PROMPTS));

export function injectCaveman(body, format, level) {
  const prompt = CAVEMAN_PROMPTS[level];
  if (!body || !prompt) return;

  // Kiro format: body.conversationState wraps system message in conversationState.systemMessage.text
  if (body.conversationState) {
    injectKiroSystem(body, prompt);
    return;
  }

  switch (format) {
    case FORMATS.CLAUDE:
      injectClaudeSystem(body, prompt);
      return;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
    case FORMATS.ANTIGRAVITY:
      // Antigravity wraps Gemini shape in body.request → injectGeminiSystem handles it
      injectGeminiSystem(body, prompt);
      return;
    default:
      // OpenAI and OpenAI-shaped formats (responses/codex/cursor/kiro/ollama)
      injectMessagesSystem(body, prompt);
  }
}

// OpenAI-shaped: messages[] (chat) or input[] (responses) or instructions (responses string)
function injectMessagesSystem(body, prompt) {
  // OpenAI Responses API: top-level string field
  if (typeof body.instructions === "string") {
    body.instructions = stripExistingPromptText(body.instructions);
    body.instructions = body.instructions
      ? `${body.instructions}${SEP}${prompt}`
      : prompt;
    return;
  }

  const isChat = Array.isArray(body.messages);
  const isResponses = !isChat && Array.isArray(body.input);
  const arr = isChat ? body.messages
    : isResponses ? body.input
      : null;
  if (!arr) return;

  const idx = arr.findIndex(m => m && (m.role === "system" || m.role === "developer"));
  if (idx >= 0) {
    appendToOpenAIMessage(arr[idx], prompt, isResponses ? "input_text" : "text");
  } else {
    arr.unshift({ role: "system", content: isResponses ? [{ type: "input_text", text: prompt }] : prompt });
  }
}

function appendToOpenAIMessage(msg, prompt, partType) {
  if (typeof msg.content === "string") {
    msg.content = stripExistingPromptText(msg.content);
    msg.content = `${msg.content}${SEP}${prompt}`;
  } else if (Array.isArray(msg.content)) {
    msg.content = stripExistingPromptParts(msg.content);
    msg.content.push({ type: partType, text: prompt });
  } else {
    msg.content = prompt;
  }
}

// Claude shape: body.system as string | array of {type:"text", text}
// Insert before the last cache_control block to keep caveman inside the cached prefix.
function injectClaudeSystem(body, prompt) {
  if (typeof body.system === "string" && body.system.length > 0) {
    body.system = stripExistingPromptText(body.system);
    body.system = `${body.system}${SEP}${prompt}`;
    return;
  }
  if (Array.isArray(body.system)) {
    body.system = stripExistingPromptParts(body.system);
    const block = { type: "text", text: prompt };
    let lastCacheIdx = -1;
    for (let i = body.system.length - 1; i >= 0; i--) {
      if (body.system[i]?.cache_control) { lastCacheIdx = i; break; }
    }
    if (lastCacheIdx >= 0) {
      body.system.splice(lastCacheIdx, 0, block);
    } else {
      body.system.push(block);
    }
    return;
  }
  body.system = prompt;
}

// Gemini shape: body.system_instruction | body.systemInstruction | body.request.systemInstruction
// Each shape: { parts: [{ text }] }
function injectGeminiSystem(body, prompt) {
  const target = body.request && typeof body.request === "object" ? body.request : body;
  const useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction");
  const key = useSnake ? "system_instruction" : "systemInstruction";
  const sys = target[key];
  if (sys && Array.isArray(sys.parts)) {
    sys.parts = stripExistingPromptParts(sys.parts);
    sys.parts.push({ text: prompt });
    return;
  }
  target[key] = { parts: [{ text: prompt }] };
}

function injectKiroSystem(body, prompt) {
  const state = body.conversationState;
  if (!state) return;
  const sys = state.systemMessage;
  if (sys && typeof sys.text === "string") {
    sys.text = stripExistingPromptText(sys.text);
    sys.text = sys.text ? `${sys.text}${SEP}${prompt}` : prompt;
    return;
  }
  state.systemMessage = { text: prompt };
}

function stripExistingPromptText(value) {
  let text = String(value || "");
  for (const oldPrompt of CAVEMAN_PROMPT_SET) {
    if (!oldPrompt) continue;
    text = text
      .split(`${SEP}${oldPrompt}`).join("")
      .split(`${oldPrompt}${SEP}`).join("")
      .split(oldPrompt).join("");
  }
  return text.trim();
}

function stripExistingPromptParts(parts) {
  return parts.filter((part) => {
    if (!part || typeof part.text !== "string") return true;
    return !CAVEMAN_PROMPT_SET.has(part.text);
  });
}
