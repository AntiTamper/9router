import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import {
  buildProviderHeaders,
  buildProviderUrl,
} from "../../open-sse/services/provider.js";

describe("Kimi Code API key provider", () => {
  it("uses the Kimi Code OpenAI-compatible endpoint", () => {
    expect(PROVIDERS.kimi.baseUrl).toBe(
      "https://api.kimi.com/coding/v1/chat/completions",
    );
    expect(PROVIDERS.kimi.baseUrls).toEqual([
      "https://api.kimi.com/coding/v1/chat/completions",
    ]);

    const executor = new DefaultExecutor("kimi");
    expect(executor.buildUrl("kimi-for-coding", true)).toBe(PROVIDERS.kimi.baseUrl);
    expect(buildProviderUrl("kimi", "kimi-for-coding", true)).toBe(
      PROVIDERS.kimi.baseUrl,
    );
  });

  it("does not append Claude beta query params to Kimi Code requests", () => {
    const executor = new DefaultExecutor("kimi");
    expect(executor.getFallbackCount()).toBe(1);
    expect(executor.shouldRetry(401, 0)).toBe(false);
    expect(executor.buildUrl("kimi-for-coding", true)).not.toContain("beta=true");
  });

  it("sends Kimi API keys as bearer for OpenAI-compatible requests", () => {
    const executor = new DefaultExecutor("kimi");
    const executorHeaders = executor.buildHeaders({ apiKey: "sk-kimi" }, true);
    const serviceHeaders = buildProviderHeaders(
      "kimi",
      { apiKey: "sk-kimi" },
      true,
    );

    for (const headers of [executorHeaders, serviceHeaders]) {
      expect(headers.Authorization).toBe("Bearer sk-kimi");
      expect(headers["x-api-key"]).toBeUndefined();
    }
  });

  it("supports Kimi API as a separate Moonshot provider", () => {
    expect(PROVIDERS["kimi-api"].baseUrls).toEqual([
      "https://api.moonshot.ai/v1/chat/completions",
      "https://api.moonshot.cn/v1/chat/completions",
    ]);

    const executor = new DefaultExecutor("kimi-api");
    expect(executor.buildUrl("kimi-k2.6", true)).toBe(PROVIDERS["kimi-api"].baseUrl);
    expect(executor.shouldRetry(401, 0)).toBe(true);

    const headers = executor.buildHeaders({ apiKey: "sk-moonshot" }, true);
    expect(headers.Authorization).toBe("Bearer sk-moonshot");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});
