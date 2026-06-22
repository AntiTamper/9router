import { describe, expect, it } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("upstream 0.5.8 regressions", () => {
  it("flattens Cloudflare AI content arrays to text strings", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: " world" }] }] };
    stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama", body);
    expect(body.messages[0].content).toBe("hello world");
  });

  it("normalizes OpenAI-style tools before sending to Anthropic-compatible providers", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
    };
    prepareClaudeRequest(body, "minimax");
    expect(body.tools[0]).toEqual({
      name: "lookup",
      description: "Lookup",
      input_schema: { type: "object", properties: { q: { type: "string" } } },
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });

  it("marks MiniMax-M3 as vision capable without widening all MiniMax models", () => {
    expect(getCapabilitiesForModel("minimax", "minimax-m3").vision).toBe(true);
    expect(getCapabilitiesForModel("minimax", "minimax-m2.7").vision).not.toBe(true);
  });
});
