// Custom system-instruction injector: injects an operator-defined instruction
// into the system message of the final request body, just before dispatch.
// Mirrors the caveman injector's format dispatch so it works across every
// provider shape (OpenAI chat/responses, Claude, Gemini, Kiro).
//
// mode:
//   "append"  (default) -> add AFTER the existing system text
//   "prepend"           -> add BEFORE the existing system text
//   "replace"           -> replace the system text entirely
//
// The injection is idempotent within a single request and does not strip the
// client's own system prompt (except in "replace" mode).

import { FORMATS } from "../translator/formats.js";

const SEP = "\n\n";

function normalizeMode(mode) {
  return mode === "prepend" || mode === "replace" ? mode : "append";
}

function combine(existing, instruction, mode) {
  const base = String(existing || "").trim();
  if (mode === "replace" || !base) return instruction;
  if (mode === "prepend") return `${instruction}${SEP}${base}`;
  return `${base}${SEP}${instruction}`;
}

export function injectCustomInstruction(body, format, text, mode = "append") {
  const instruction = typeof text === "string" ? text.trim() : "";
  if (!body || !instruction) return false;
  const m = normalizeMode(mode);

  if (body.conversationState) {
    injectKiroSystem(body, instruction, m);
    return true;
  }

  switch (format) {
    case FORMATS.CLAUDE:
      injectClaudeSystem(body, instruction, m);
      return true;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
    case FORMATS.ANTIGRAVITY:
      injectGeminiSystem(body, instruction, m);
      return true;
    default:
      injectMessagesSystem(body, instruction, m);
      return true;
  }
}

// OpenAI-shaped: instructions (responses string) | messages[] | input[]
function injectMessagesSystem(body, instruction, mode) {
  if (typeof body.instructions === "string") {
    body.instructions = combine(body.instructions, instruction, mode);
    return;
  }

  const isChat = Array.isArray(body.messages);
  const isResponses = !isChat && Array.isArray(body.input);
  const arr = isChat ? body.messages : isResponses ? body.input : null;
  if (!arr) {
    // No message array (e.g. responses with only `instructions` absent): set it.
    body.instructions = instruction;
    return;
  }

  const partType = isResponses ? "input_text" : "text";
  const idx = arr.findIndex((msg) => msg && (msg.role === "system" || msg.role === "developer"));
  if (idx < 0) {
    arr.unshift({ role: "system", content: isResponses ? [{ type: partType, text: instruction }] : instruction });
    return;
  }
  const msg = arr[idx];
  if (typeof msg.content === "string") {
    msg.content = combine(msg.content, instruction, mode);
  } else if (Array.isArray(msg.content)) {
    if (mode === "replace") {
      msg.content = [{ type: partType, text: instruction }];
    } else if (mode === "prepend") {
      msg.content.unshift({ type: partType, text: instruction });
    } else {
      msg.content.push({ type: partType, text: instruction });
    }
  } else {
    msg.content = instruction;
  }
}

// Claude shape: body.system as string | array of {type:"text", text}
function injectClaudeSystem(body, instruction, mode) {
  if (typeof body.system === "string") {
    body.system = combine(body.system, instruction, mode);
    return;
  }
  if (Array.isArray(body.system)) {
    if (mode === "replace") {
      body.system = [{ type: "text", text: instruction }];
      return;
    }
    const block = { type: "text", text: instruction };
    if (mode === "prepend") body.system.unshift(block);
    else body.system.push(block);
    return;
  }
  body.system = instruction;
}

// Gemini shape: body.system_instruction | body.systemInstruction | body.request.systemInstruction
function injectGeminiSystem(body, instruction, mode) {
  const target = body.request && typeof body.request === "object" ? body.request : body;
  const useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction");
  const key = useSnake ? "system_instruction" : "systemInstruction";
  const sys = target[key];
  const part = { text: instruction };
  if (sys && Array.isArray(sys.parts)) {
    if (mode === "replace") sys.parts = [part];
    else if (mode === "prepend") sys.parts.unshift(part);
    else sys.parts.push(part);
    return;
  }
  target[key] = { parts: [part] };
}

function injectKiroSystem(body, instruction, mode) {
  const state = body.conversationState;
  if (!state) return;
  const sys = state.systemMessage;
  if (sys && typeof sys.text === "string") {
    sys.text = combine(sys.text, instruction, mode);
    return;
  }
  state.systemMessage = { text: instruction };
}