import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  guardedFetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/lib/security/urlGuard", () => ({ guardedFetch: mocks.guardedFetch }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models performance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([
      {
        provider: "openai-compatible-slow",
        apiKey: "sk-test",
        isActive: true,
        providerSpecificData: {
          prefix: "slow",
          baseUrl: "https://slow.example/v1",
        },
      },
    ]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.guardedFetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "remote-model" }] }), {
      headers: { "content-type": "application/json" },
    }));
  });

  it("does not probe remote compatible providers on the default model-list path", async () => {
    const models = await buildModelsList(["llm"]);

    expect(models).toEqual([]);
    expect(mocks.guardedFetch).not.toHaveBeenCalled();
  });

  it("keeps remote model probing available behind the live option", async () => {
    const models = await buildModelsList(["llm"], { includeRemoteFetches: true });

    expect(mocks.guardedFetch).toHaveBeenCalledTimes(1);
    expect(models).toEqual([
      { id: "slow/remote-model", object: "model", owned_by: "slow" },
    ]);
  });
});
