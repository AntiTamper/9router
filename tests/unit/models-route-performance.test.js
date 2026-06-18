import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  guardedFetch: vi.fn(),
  resolveKimiModels: vi.fn(),
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
vi.mock("../../open-sse/services/kimiModels.js", () => ({ resolveKimiModels: mocks.resolveKimiModels }));

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
    mocks.resolveKimiModels.mockResolvedValue(null);
  });

  it("does not probe remote compatible providers on the default model-list path", async () => {
    const models = await buildModelsList(["llm"]);

    expect(models).toEqual([]);
    expect(mocks.guardedFetch).not.toHaveBeenCalled();
  });

  it("can skip static fallback when a caller needs active providers only", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);

    const models = await buildModelsList(["llm"], { staticFallbackOnNoConnections: false });

    expect(models).toEqual([]);
  });

  it("keeps remote model probing available behind the live option", async () => {
    const models = await buildModelsList(["llm"], { includeRemoteFetches: true });

    expect(mocks.guardedFetch).toHaveBeenCalledTimes(1);
    expect(models).toEqual([
      { id: "slow/remote-model", object: "model", owned_by: "slow" },
    ]);
  });

  it("uses Kimi live context metadata while exposing the default upstream model ID", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { provider: "kimi", apiKey: "sk-kimi", isActive: true, providerSpecificData: {} },
    ]);
    mocks.resolveKimiModels.mockResolvedValue({
      models: [{ id: "kimi-for-coding", upstreamModelId: "kimi-for-coding", contextWindow: 1048576 }],
    });

    const models = await buildModelsList(["llm"], { includeRemoteFetches: true });

    expect(mocks.resolveKimiModels).toHaveBeenCalledWith(
      "kimi",
      { apiKey: "sk-kimi", accessToken: undefined },
      { log: console },
    );
    expect(models).toEqual([
      {
        id: "kimi/kimi-for-coding",
        object: "model",
        owned_by: "kimi",
        context_window: 1048576,
        contextWindow: 1048576,
        max_input_tokens: 1044480,
      },
    ]);
  });

  it("exposes live Kimi K2.7 Code when the upstream catalog returns the real model ID", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { provider: "kimi", apiKey: "sk-kimi", isActive: true, providerSpecificData: {} },
    ]);
    mocks.resolveKimiModels.mockResolvedValue({
      models: [{ id: "kimi-k2.7-code", upstreamModelId: "kimi-k2.7-code", contextWindow: 262144 }],
    });

    const models = await buildModelsList(["llm"], { includeRemoteFetches: true });

    expect(models[0]).toMatchObject({
      id: "kimi/kimi-k2.7-code",
      object: "model",
      owned_by: "kimi",
      context_window: 262144,
      max_input_tokens: 258048,
    });
  });
});
