export default {
  id: "kimi-api",
  priority: 171,
  alias: "moonshot",
  uiAlias: "kimi-api",
  display: {
    name: "Kimi API",
    icon: "psychology",
    color: "#0F766E",
    textIcon: "KA",
    website: "https://platform.kimi.com",
    notice: {
      text: "Moonshot/Kimi platform API key. Supports api.moonshot.ai and api.moonshot.cn.",
      apiKeyUrl: "https://platform.kimi.com/console/api-keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrls: [
      "https://api.moonshot.ai/v1/chat/completions",
      "https://api.moonshot.cn/v1/chat/completions",
    ],
    baseUrl: "https://api.moonshot.ai/v1/chat/completions",
    modelsUrls: [
      "https://api.moonshot.ai/v1/models",
      "https://api.moonshot.cn/v1/models",
    ],
    modelsUrl: "https://api.moonshot.ai/v1/models",
    format: "openai",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262144, unsupportedParams: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "thinking", "reasoning", "reasoning_effort", "enable_thinking"], unsupportedExtraBodyParams: ["thinking", "enable_thinking"] },
    { id: "kimi-for-coding", name: "Kimi for Coding", contextWindow: 262144 },
    { id: "kimi-k2.6", name: "Kimi K2.6", upstreamModelId: "kimi-for-coding", contextWindow: 262144 },
  ],
  serviceKinds: ["llm", "webSearch"],
  searchViaChat: {
    defaultModel: "kimi-k2.7-code",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    pricingUrl: "https://platform.kimi.com/docs/pricing/chat",
  },
};
