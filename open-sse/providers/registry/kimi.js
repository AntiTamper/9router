export default {
  id: "kimi",
  priority: 170,
  alias: "kimi",
  display: {
    name: "Kimi",
    icon: "psychology",
    color: "#1E3A8A",
    textIcon: "KM",
    website: "https://kimi.moonshot.cn",
    notice: {
      apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.kimi.com/coding/v1/chat/completions",
    openaiBaseUrl: "https://api.kimi.com/coding/v1/chat/completions",
    anthropicBaseUrl: "https://api.kimi.com/coding/v1/messages",
    baseUrls: ["https://api.kimi.com/coding/v1/chat/completions"],
    modelsUrl: "https://api.kimi.com/coding/v1/models",
    format: "openai",
    headers: {},
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
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
  serviceKinds: ["llm"],
};
