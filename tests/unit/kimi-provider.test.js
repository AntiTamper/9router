import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { CHAT_SEARCH_CONFIG } from "../../open-sse/handlers/search/chatSearch.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { resolveFetchConnectTimeoutMs } from "../../open-sse/executors/base.js";
import {
  buildProviderHeaders,
  buildProviderUrl,
} from "../../open-sse/services/provider.js";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getDefaultModel, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { resolveModelContextWindow } from "../../open-sse/services/contextWindow.js";
import { buildKimiCodingAgentHeaders, buildKimiOpenAICompatibilityHeaders, detectKimiCodingAgent } from "../../open-sse/utils/kimiCodingAgentHeaders.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { isLocalProxyFailure } from "../../open-sse/utils/error.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Kimi Code API key provider", () => {
  it("uses the Kimi Code OpenAI-compatible endpoint", () => {
    expect(PROVIDERS.kimi.baseUrl).toBe(
      "https://api.kimi.com/coding/v1/chat/completions",
    );
    expect(PROVIDERS.kimi.anthropicBaseUrl).toBe(
      "https://api.kimi.com/coding/v1/messages",
    );
    expect(PROVIDERS.kimi.baseUrls).toEqual([
      "https://api.kimi.com/coding/v1/chat/completions",
    ]);

    const executor = new DefaultExecutor("kimi");
    expect(executor.buildUrl("kimi-k2.6", true)).toBe(PROVIDERS.kimi.baseUrl);
    expect(
      executor.buildUrl("kimi-k2.6", true, 0, null, { targetFormat: "claude" }),
    ).toBe(PROVIDERS.kimi.anthropicBaseUrl);
    expect(buildProviderUrl("kimi", "kimi-k2.6", true)).toBe(
      PROVIDERS.kimi.baseUrl,
    );
  });

  it("exposes Kimi Coding's default upstream model ID", () => {
    expect(getDefaultModel("kimi")).toBe("kimi-for-coding");
    expect(getModelUpstreamId("kimi", "kimi-for-coding")).toBe("kimi-for-coding");

    const executor = new DefaultExecutor("kimi");
    const transformed = executor.transformRequest("kimi-for-coding", {
      model: "kimi-for-coding",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(transformed.model).toBe("kimi-for-coding");
    expect(transformed.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps Kimi K2.7 Code available when explicitly requested", () => {
    expect(getModelUpstreamId("kmc", "kimi-k2.7-code")).toBe("kimi-k2.7-code");

    const executor = new DefaultExecutor("kimi");
    const transformed = executor.transformRequest("kimi-k2.7-code", {
      model: "kimi-k2.7-code",
      max_tokens: 1,
      temperature: 0.2,
      top_p: 0.9,
      thinking: { type: "enabled", budget_tokens: 10000 },
      reasoning_effort: "high",
      extra_body: { thinking: { type: "enabled" }, enable_thinking: true, keep: true },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(transformed.model).toBe("kimi-k2.7-code");
    expect(transformed.temperature).toBeUndefined();
    expect(transformed.top_p).toBeUndefined();
    expect(transformed.thinking).toBeUndefined();
    expect(transformed.reasoning_effort).toBeUndefined();
    expect(transformed.extra_body).toEqual({ keep: true });
    expect(transformed.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps the legacy Kimi K2.6 alias mapped to Kimi Code's stable upstream model ID", () => {
    expect(getModelUpstreamId("kimi", "kimi-k2.6")).toBe("kimi-for-coding");
    expect(getModelUpstreamId("kmc", "kimi-k2.6")).toBe("kimi-for-coding");

    const executor = new DefaultExecutor("kimi");
    const transformed = executor.transformRequest("kimi-k2.6", {
      model: "kimi-k2.6",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(transformed.model).toBe("kimi-for-coding");
    expect(transformed.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps Kimi live catalog context from upstream ID to exposed model ID", () => {
    const resolved = resolveModelContextWindow({
      alias: "kimi",
      providerId: "kimi",
      modelId: "kimi-k2.6",
      live: {
        kimi: [{ id: "kimi-for-coding", upstreamModelId: "kimi-for-coding", contextWindow: 1048576 }],
      },
    });

    expect(resolved.contextWindow).toBe(1048576);
    expect(resolved.source).toBe("live");
  });

  it("preserves Claude-format Kimi requests on the Anthropic-style endpoint", () => {
    const executor = new DefaultExecutor("kimi");
    const transformed = executor.transformRequest(
      "kimi-k2.6",
      {
        model: "kimi-k2.6",
        max_tokens: 1,
        system: [{ type: "text", text: "system prompt" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      true,
      { apiKey: "sk-kimi" },
      { targetFormat: "claude" },
    );

    expect(transformed.model).toBe("kimi-for-coding");
    expect(transformed.system[0].text).toBe("system prompt");
    expect(transformed.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("does not force JSON Kimi responses through the SSE converter", async () => {
    const response = new Response(JSON.stringify({ id: "chatcmpl_ok" }), {
      headers: { "content-type": "application/json" },
    });

    const result = await handleForcedSSEToJson({
      providerResponse: response,
      provider: "kimi",
      model: "kimi-k2.6",
    });

    expect(result).toBeNull();
  });

  it("classifies local Kimi parser errors without treating them as account failures", () => {
    expect(
      isLocalProxyFailure(502, "Invalid SSE response for non-streaming request"),
    ).toBe(true);
    expect(isLocalProxyFailure(502, "Invalid JSON response from kimi")).toBe(true);
    expect(isLocalProxyFailure(502, "[502]: fetch connect timeout")).toBe(true);
    expect(isLocalProxyFailure(502, "[502]: upstream gateway timeout")).toBe(false);
    expect(
      isLocalProxyFailure(403, "Invalid SSE response for non-streaming request"),
    ).toBe(false);
  });

  it("gives Kimi Responses compact requests a longer first-byte timeout", () => {
    expect(resolveFetchConnectTimeoutMs({ provider: "kimi", sourceFormat: FORMATS.OPENAI_RESPONSES })).toBe(120000);
    expect(resolveFetchConnectTimeoutMs({ provider: "kimi", sourceFormat: FORMATS.OPENAI })).toBe(20000);
    expect(resolveFetchConnectTimeoutMs({ provider: "openai", sourceFormat: FORMATS.OPENAI_RESPONSES })).toBe(20000);
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

  it("bridges generic OpenAI-compatible clients with Kimi Code compatibility headers", () => {
    const executor = new DefaultExecutor("kimi");
    const headers = executor.buildHeaders({ apiKey: "sk-kimi" }, true, {
      clientRawRequest: { headers: { "user-agent": "node" } },
    });

    expect(headers.Authorization).toBe("Bearer sk-kimi");
    expect(headers["user-agent"]).toContain("claude-cli/");
    expect(headers["x-app"]).toBe("cli");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
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

  it("prefers real coding-agent headers over compatibility bridge headers", () => {
    const { agent, headers } = buildKimiOpenAICompatibilityHeaders({
      "User-Agent": "Roo-Code/3.0",
      "X-App": "roo",
    });
    expect(agent).toBe("roo-code");
    expect(headers["user-agent"]).toBe("Roo-Code/3.0");
    expect(headers["x-app"]).toBe("roo");
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
    expect(CHAT_SEARCH_CONFIG["kimi-api"].defaultModel).toBe("kimi-k2.7-code");
  });
});
