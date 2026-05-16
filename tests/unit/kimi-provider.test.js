import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import {
  buildProviderHeaders,
  buildProviderUrl,
} from "../../open-sse/services/provider.js";

describe("Kimi Code API key provider", () => {
  it("uses the Kimi Code Anthropic-compatible endpoint without beta query", () => {
    expect(PROVIDERS.kimi.baseUrl).toBe(
      "https://api.kimi.com/coding/v1/messages",
    );
    expect(PROVIDERS.kimi.openaiBaseUrl).toBe(
      "https://api.kimi.com/coding/v1/chat/completions",
    );

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

  it("sends Kimi API keys as bearer and x-api-key for compatibility", () => {
    const executor = new DefaultExecutor("kimi");
    const executorHeaders = executor.buildHeaders({ apiKey: "sk-kimi" }, true);
    const serviceHeaders = buildProviderHeaders(
      "kimi",
      { apiKey: "sk-kimi" },
      true,
    );

    for (const headers of [executorHeaders, serviceHeaders]) {
      expect(headers.Authorization).toBe("Bearer sk-kimi");
      expect(headers["x-api-key"]).toBe("sk-kimi");
      expect(headers["Anthropic-Version"] || headers["anthropic-version"]).toBe(
        "2023-06-01",
      );
    }
  });
});
