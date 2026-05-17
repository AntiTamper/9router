import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { CHAT_SEARCH_CONFIG } from "../../open-sse/handlers/search/chatSearch.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import {
  buildProviderHeaders,
  buildProviderUrl,
} from "../../open-sse/services/provider.js";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getDefaultModel, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { buildKimiCodingAgentHeaders, detectKimiCodingAgent } from "../../open-sse/utils/kimiCodingAgentHeaders.js";

describe("Kimi Code API key provider", () => {
  it("uses the Kimi Code OpenAI-compatible endpoint", () => {
    expect(PROVIDERS.kimi.baseUrl).toBe(
      "https://api.kimi.com/coding/v1/chat/completions",
    );
    expect(PROVIDERS.kimi.baseUrls).toEqual([
      "https://api.kimi.com/coding/v1/chat/completions",
    ]);

    const executor = new DefaultExecutor("kimi");
    expect(executor.buildUrl("kimi-k2.6", true)).toBe(PROVIDERS.kimi.baseUrl);
    expect(buildProviderUrl("kimi", "kimi-k2.6", true)).toBe(
      PROVIDERS.kimi.baseUrl,
    );
  });

  it("exposes Kimi K2.6 while sending Kimi Code's stable upstream model ID", () => {
    expect(getDefaultModel("kimi")).toBe("kimi-k2.6");
    expect(getModelUpstreamId("kimi", "kimi-k2.6")).toBe("kimi-for-coding");
    expect(getModelUpstreamId("kmc", "kimi-k2.6")).toBe("kimi-for-coding");

    const executor = new DefaultExecutor("kimi");
    const transformed = executor.transformRequest("kimi-k2.6", {
      model: "kimi-k2.6",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(transformed.model).toBe("kimi-for-coding");
  });

  it("does not append Claude beta query params to Kimi Code requests", () => {
    const executor = new DefaultExecutor("kimi");
    expect(executor.getFallbackCount()).toBe(1);
    expect(executor.shouldRetry(401, 0)).toBe(false);
    expect(executor.buildUrl("kimi-k2.6", true)).not.toContain("beta=true");
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

  it("forwards real coding-agent identity headers to Kimi Code without leaking client auth", () => {
    const executor = new DefaultExecutor("kimi");
    const headers = executor.buildHeaders({ apiKey: "sk-kimi" }, true, {
      clientRawRequest: {
        headers: {
          "user-agent": "Roo-Code/3.0",
          authorization: "Bearer client-secret",
          cookie: "session=secret",
          "x-app": "roo",
        },
      },
    });

    expect(headers.Authorization).toBe("Bearer sk-kimi");
    expect(headers["user-agent"]).toBe("Roo-Code/3.0");
    expect(headers["x-app"]).toBe("roo");
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });

  it("does not spoof Kimi Code coding-agent headers for dashboard/internal probes", () => {
    const executor = new DefaultExecutor("kimi");
    const headers = executor.buildHeaders({ apiKey: "sk-kimi" }, true, {
      clientRawRequest: { headers: { "user-agent": "node" } },
    });

    expect(headers.Authorization).toBe("Bearer sk-kimi");
    expect(headers["user-agent"]).toBeUndefined();
  });

  it("detects supported Kimi Code clients for identity forwarding", () => {
    expect(detectKimiCodingAgent({ "user-agent": "claude-cli/2.1.138" })).toBe("claude-code");
    expect(detectKimiCodingAgent({ "user-agent": "Roo-Code/3.0" })).toBe("roo-code");
    expect(detectKimiCodingAgent({ "user-agent": "OpenCode/1.0" })).toBe("opencode");
    expect(detectKimiCodingAgent({ "user-agent": "node" })).toBeNull();

    const { headers } = buildKimiCodingAgentHeaders({
      "User-Agent": "claude-code/2.1.138",
      "Anthropic-Version": "2023-06-01",
      Authorization: "Bearer secret",
    });
    expect(headers["user-agent"]).toBe("claude-code/2.1.138");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
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

  it("keeps Kimi Code out of generic web-search and uses Kimi API for Moonshot search", () => {
    expect(AI_PROVIDERS.kimi.serviceKinds).toEqual(["llm"]);
    expect(AI_PROVIDERS["kimi-api"].serviceKinds).toContain("webSearch");
    expect(CHAT_SEARCH_CONFIG.kimi).toBeUndefined();
    expect(CHAT_SEARCH_CONFIG["kimi-api"].defaultModel).toBe("kimi-k2.6");
  });
});
