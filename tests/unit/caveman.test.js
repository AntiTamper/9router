import { describe, expect, it } from "vitest";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function collectText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value).map(collectText).join("\n");
  }
  return "";
}

function countPrompt(value, prompt) {
  return collectText(value).split(prompt).length - 1;
}

describe("Caveman token saver", () => {
  it("injects OpenAI chat system prompt once", () => {
    const body = { messages: [{ role: "system", content: "Base policy" }, { role: "user", content: "hi" }] };

    injectCaveman(body, FORMATS.OPENAI, "full");
    injectCaveman(body, FORMATS.OPENAI, "full");

    expect(body.messages[0].content).toContain("Base policy");
    expect(countPrompt(body, CAVEMAN_PROMPTS.full)).toBe(1);
  });

  it("uses text parts for OpenAI chat content arrays", () => {
    const body = { messages: [{ role: "developer", content: [{ type: "text", text: "Base policy" }] }] };

    injectCaveman(body, FORMATS.OPENAI, "ultra");

    expect(body.messages[0].content.at(-1)).toEqual({ type: "text", text: CAVEMAN_PROMPTS.ultra });
  });

  it("uses input_text parts for OpenAI Responses input arrays", () => {
    const body = { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };

    injectCaveman(body, FORMATS.OPENAI_RESPONSES, "lite");

    expect(body.input[0]).toEqual({
      role: "system",
      content: [{ type: "input_text", text: CAVEMAN_PROMPTS.lite }],
    });
  });

  it("switches levels without accumulating old prompts", () => {
    const body = { messages: [{ role: "system", content: "Base policy" }] };

    injectCaveman(body, FORMATS.OPENAI, "lite");
    injectCaveman(body, FORMATS.OPENAI, "wenyan-ultra");

    expect(body.messages[0].content).toContain("Base policy");
    expect(countPrompt(body, CAVEMAN_PROMPTS.lite)).toBe(0);
    expect(countPrompt(body, CAVEMAN_PROMPTS["wenyan-ultra"])).toBe(1);
  });

  it("keeps Claude system prompt before cache breakpoint and idempotent", () => {
    const body = {
      system: [
        { type: "text", text: "Base policy" },
        { type: "text", text: "cache here", cache_control: { type: "ephemeral" } },
      ],
    };

    injectCaveman(body, FORMATS.CLAUDE, "full");
    injectCaveman(body, FORMATS.CLAUDE, "full");

    expect(body.system[1]).toEqual({ type: "text", text: CAVEMAN_PROMPTS.full });
    expect(body.system[2].cache_control).toEqual({ type: "ephemeral" });
    expect(countPrompt(body, CAVEMAN_PROMPTS.full)).toBe(1);
  });

  it("supports Gemini and Antigravity wrapper idempotently", () => {
    const body = { request: { contents: [], systemInstruction: { parts: [{ text: "Base policy" }] } } };

    injectCaveman(body, FORMATS.ANTIGRAVITY, "wenyan-lite");
    injectCaveman(body, FORMATS.ANTIGRAVITY, "wenyan-lite");

    expect(body.request.systemInstruction.parts.at(-1)).toEqual({ text: CAVEMAN_PROMPTS["wenyan-lite"] });
    expect(countPrompt(body, CAVEMAN_PROMPTS["wenyan-lite"])).toBe(1);
  });
});
