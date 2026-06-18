import { CLAUDE_API_HEADERS, KIMI_CODING_BASE_URL } from "../shared.js";

export default {
  id: "kimi-coding",
  hidden: true,
  priority: 120,
  alias: "kmc",
  display: {
    name: "Kimi Coding",
    icon: "psychology",
    color: "#1E40AF",
    textIcon: "KC",
    website: "https://kimi.moonshot.cn",
    notice: {
      signupUrl: "https://kimi.moonshot.cn",
    },
  },
  category: "oauth",
  transport: {
    baseUrl: "https://api.kimi.com/coding/v1/messages",
    modelsUrl: "https://api.kimi.com/coding/v1/models",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    },
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    refreshUrl: "https://auth.kimi.com/api/oauth/token",
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
      hooks: [
        "kimiHeaders",
      ],
    },
  },
  models: [
    { id: "kimi-for-coding", name: "Kimi for Coding", contextWindow: 262144 },
    { id: "kimi-k2.6", name: "Kimi K2.6", upstreamModelId: "kimi-for-coding", contextWindow: 262144 },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262144, unsupportedParams: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "thinking", "reasoning", "reasoning_effort", "enable_thinking"], unsupportedExtraBodyParams: ["thinking", "enable_thinking"] },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "kimi-k2.5-thinking", name: "Kimi K2.5 Thinking" },
    { id: "kimi-latest", name: "Kimi Latest" },
  ],
  oauth: {
    deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    refreshLeadMs: 300000,
  },
  features: {
    usage: true,
  },
};
