import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildModelsList: vi.fn(),
}));

vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: mocks.buildModelsList,
}));

const { GET } = await import("../../src/app/api/models/matching/route.js");

describe("/api/models/matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildModelsList.mockResolvedValue([
      { id: "cc/claude-sonnet-4-5-20250929", object: "model", owned_by: "cc" },
      { id: "gh/claude-sonnet-4-5-20250929", object: "model", owned_by: "gh" },
      { id: "kimi/kimi-for-coding", object: "model", owned_by: "kimi", context_window: 262144 },
      { id: "combo-claude", object: "model", owned_by: "combo" },
    ]);
  });

  it("returns active provider-prefixed models matching a bare model ID", async () => {
    const response = await GET(new Request("http://localhost/api/models/matching?model=claude-sonnet-4-5-20250929"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.buildModelsList).toHaveBeenCalledWith(["llm"], {
      includeRemoteFetches: true,
      staticFallbackOnNoConnections: false,
    });
    expect(data).toEqual({
      targetModel: "claude-sonnet-4-5-20250929",
      matches: [
        {
          id: "cc/claude-sonnet-4-5-20250929",
          providerAlias: "cc",
          modelId: "claude-sonnet-4-5-20250929",
          owned_by: "cc",
        },
        {
          id: "gh/claude-sonnet-4-5-20250929",
          providerAlias: "gh",
          modelId: "claude-sonnet-4-5-20250929",
          owned_by: "gh",
        },
      ],
    });
  });

  it("accepts prefixed input and returns the unprefixed target model", async () => {
    const response = await GET(new Request("http://localhost/api/models/matching?model=kimi%2Fkimi-for-coding"));
    const data = await response.json();

    expect(data.targetModel).toBe("kimi-for-coding");
    expect(data.matches).toEqual([
      {
        id: "kimi/kimi-for-coding",
        providerAlias: "kimi",
        modelId: "kimi-for-coding",
        owned_by: "kimi",
        context_window: 262144,
      },
    ]);
  });
});
