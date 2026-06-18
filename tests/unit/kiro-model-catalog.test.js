import { describe, it, expect } from "vitest";
import { getProviderModels } from "../../open-sse/config/providerModels.js";
import { resolveKiroModel } from "../../open-sse/config/kiroConstants.js";

describe("Kiro model catalog", () => {
  it("keeps static fallback aligned with upstream refactor registry", () => {
    const ids = getProviderModels("kr").map((model) => model.id);
    expect(ids).toContain("claude-sonnet-4.5");
    expect(ids).toContain("claude-haiku-4.5");
    expect(ids).toContain("qwen3-coder-next");
    expect(ids).toContain("MiniMax-M2.5");
  });

  it("keeps explicit synthetic variants present in static fallback", () => {
    const ids = getProviderModels("kr").map((model) => model.id);
    expect(ids).toContain("claude-sonnet-4.5-thinking-agentic");
    expect(ids).toContain("claude-haiku-4.5-agentic");
  });

  it("strips synthetic suffixes before Kiro upstream dispatch", () => {
    expect(resolveKiroModel("claude-sonnet-4.5-thinking-agentic")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: true,
      thinking: true,
    });
  });
});
