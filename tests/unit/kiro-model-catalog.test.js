import { describe, it, expect } from "vitest";
import { getProviderModels } from "../../open-sse/config/providerModels.js";
import { resolveKiroModel } from "../../open-sse/config/kiroConstants.js";

describe("Kiro model catalog", () => {
  it("keeps the static fallback aligned with current Kiro models", () => {
    const ids = getProviderModels("kr").map((model) => model.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("claude-opus-4.7");
    expect(ids).toContain("claude-sonnet-4.6");
    expect(ids).toContain("claude-sonnet-4");
    expect(ids).toContain("minimax-m2.5");
    expect(ids).toContain("minimax-m2.1");
    expect(ids).not.toContain("MiniMax-M2.5");
  });

  it("adds synthetic thinking and agentic variants except for auto agentic", () => {
    const ids = getProviderModels("kr").map((model) => model.id);
    expect(ids).toContain("claude-opus-4.7-thinking-agentic");
    expect(ids).toContain("qwen3-coder-next-agentic");
    expect(ids).toContain("auto-thinking");
    expect(ids).not.toContain("auto-agentic");
    expect(ids).not.toContain("auto-thinking-agentic");
  });

  it("strips synthetic suffixes before Kiro upstream dispatch", () => {
    expect(resolveKiroModel("claude-opus-4.7-thinking-agentic")).toEqual({
      upstream: "claude-opus-4.7",
      agentic: true,
      thinking: true,
    });
  });
});
