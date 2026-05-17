import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { OAUTH_ENDPOINTS, buildKimiHeaders } from "../config/appConstants.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { buildClineHeaders } from "../../src/shared/utils/clineAuth.js";
import { getCachedClaudeHeaders } from "../utils/claudeHeaderCache.js";
import { buildKimiOpenAICompatibilityHeaders } from "../utils/kimiCodingAgentHeaders.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";

const KIMI_CODING_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

function hasKimiCodingSystemPrompt(messages = []) {
  return messages.some((message) => {
    if (message?.role !== "system") return false;
    if (typeof message.content === "string") return message.content.includes(KIMI_CODING_SYSTEM_PROMPT);
    if (!Array.isArray(message.content)) return false;
    return message.content.some((part) => part?.type === "text" && String(part.text || "").includes(KIMI_CODING_SYSTEM_PROMPT));
  });
}

function injectKimiCodingSystemPrompt(body) {
  if (!Array.isArray(body?.messages) || hasKimiCodingSystemPrompt(body.messages)) return body;
  return {
    ...body,
    messages: [
      { role: "system", content: KIMI_CODING_SYSTEM_PROMPT },
      ...body.messages,
    ],
  };
}

export class DefaultExecutor extends BaseExecutor {
  constructor(provider) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  transformRequest(model, body) {
    let transformed = injectReasoningContent({ provider: this.provider, model, body });
    if (this.provider === "kimi" || this.provider === "kimi-coding") {
      if (this.provider === "kimi") transformed = injectKimiCodingSystemPrompt(transformed);
      const alias = this.provider === "kimi-coding" ? "kmc" : "kimi";
      const upstreamModel = getModelUpstreamId(alias, transformed?.model || model);
      if (upstreamModel && upstreamModel !== transformed?.model) {
        return { ...transformed, model: upstreamModel };
      }
    }
    return transformed;
  }

  shouldRetry(status, urlIndex) {
    if (
      (this.provider === "kimi" || this.provider === "kimi-api") &&
      (status === 401 || status === 403) &&
      urlIndex + 1 < this.getFallbackCount()
    ) {
      return true;
    }
    return super.shouldRetry(status, urlIndex);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.anthropic.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    switch (this.provider) {
      case "claude":
      case "glm":
      case "minimax":
      case "minimax-cn":
        return `${this.config.baseUrl}?beta=true`;
      case "kimi":
      case "kimi-api":
        return this.getBaseUrls()[urlIndex] || this.config.baseUrl;
      case "kimi-coding":
        return `${this.config.baseUrl}?beta=true`;
      case "gemini":
        return `${this.config.baseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      default: {
        const url = this.config.baseUrl;
        if (url?.includes("{accountId}")) {
          const accountId = credentials?.providerSpecificData?.accountId;
          if (!accountId) throw new Error(`${this.provider} requires accountId in providerSpecificData`);
          return url.replace("{accountId}", accountId);
        }
        return url;
      }
    }
  }

  buildHeaders(credentials, stream = true, requestContext = null) {
    const headers = { "Content-Type": "application/json", ...this.config.headers };

    switch (this.provider) {
      case "gemini":
        credentials.apiKey ? headers["x-goog-api-key"] = credentials.apiKey : headers["Authorization"] = `Bearer ${credentials.accessToken}`;
        break;
      case "claude": {
        // Overlay live cached headers from real Claude Code client over static defaults.
        // Static headers (Title-Case) remain as cold-start fallback.
        const cached = getCachedClaudeHeaders();
        if (cached) {
          // Remove Title-Case static keys that conflict with incoming lowercase cached keys
          for (const lcKey of Object.keys(cached)) {
            // Build the Title-Case equivalent: "anthropic-version" → "Anthropic-Version"
            const titleKey = lcKey.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());

            // Special handling for Anthropic-Beta to preserve required flags like OAuth
            if (lcKey === "anthropic-beta") {
              const staticBetaStr = headers[titleKey] || headers[lcKey] || "";
              const staticFlags = new Set(staticBetaStr.split(",").map(f => f.trim()).filter(Boolean));
              const cachedFlags = new Set(cached[lcKey].split(",").map(f => f.trim()).filter(Boolean));

              // Merge all static flags (which contain oauth, thinking, etc) into the cached ones
              for (const flag of staticFlags) {
                cachedFlags.add(flag);
              }

              cached[lcKey] = Array.from(cachedFlags).join(",");
            }

            if (titleKey !== lcKey && headers[titleKey] !== undefined) {
              delete headers[titleKey];
            }
          }
          Object.assign(headers, cached);
        }
        credentials.apiKey
          ? (headers["x-api-key"] = credentials.apiKey)
          : (headers["Authorization"] = `Bearer ${credentials.accessToken}`);
        break;
      }
      case "glm":
      case "minimax":
      case "minimax-cn":
      case "kimi-coding":
        headers["x-api-key"] = credentials.apiKey || credentials.accessToken;
        if (this.provider === "kimi-coding") Object.assign(headers, buildKimiHeaders());
        break;
      case "kimi": {
        const token = credentials.apiKey || credentials.accessToken;
        headers["Authorization"] = `Bearer ${token}`;
        const agentHeaders = buildKimiOpenAICompatibilityHeaders(requestContext?.clientRawRequest?.headers || {});
        Object.assign(headers, agentHeaders.headers);
        break;
      }
      case "kimi-api": {
        const token = credentials.apiKey || credentials.accessToken;
        headers["Authorization"] = `Bearer ${token}`;
        break;
      }
      default:
        if (this.provider?.startsWith?.("anthropic-compatible-")) {
          if (credentials.apiKey) {
            headers["x-api-key"] = credentials.apiKey;
          } else if (credentials.accessToken) {
            headers["Authorization"] = `Bearer ${credentials.accessToken}`;
          }
          if (!headers["anthropic-version"]) {
            headers["anthropic-version"] = "2023-06-01";
          }
        } else if (this.provider === "gitlab") {
          // GitLab Duo uses Bearer token (PAT with ai_features scope, or OAuth access token)
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        } else if (this.provider === "codebuddy") {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        } else if (this.provider === "kilocode") {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
          if (credentials.providerSpecificData?.orgId) {
            headers["X-Kilocode-OrganizationID"] = credentials.providerSpecificData.orgId;
          }
        } else if (this.provider === "cline") {
          Object.assign(headers, buildClineHeaders(credentials.apiKey || credentials.accessToken));
        } else if (this.config?.format === "claude") {
          // Generic claude-format provider (e.g. agentrouter): x-api-key + anthropic-version
          headers["x-api-key"] = credentials.apiKey || credentials.accessToken;
          if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        }
    }

    // Strip first-party Claude Code identity headers for non-Anthropic anthropic-compatible upstreams
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (!isOfficialAnthropic) {
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
        // Strip claude-code-20250219 from Anthropic-Beta / anthropic-beta
        for (const betaKey of ["anthropic-beta", "Anthropic-Beta"]) {
          if (headers[betaKey]) {
            const filtered = headers[betaKey]
              .split(",")
              .map(s => s.trim())
              .filter(f => f && f !== "claude-code-20250219")
              .join(",");
            if (filtered) {
              headers[betaKey] = filtered;
            } else {
              delete headers[betaKey];
            }
          }
        }
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    const refreshers = {
      claude: () => this.refreshWithJSON(OAUTH_ENDPOINTS.anthropic.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.claude.clientId }, proxyOptions),
      codex: () => this.refreshWithForm(OAUTH_ENDPOINTS.openai.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.codex.clientId, scope: "openid profile email offline_access" }, proxyOptions),
      qwen: () => this.refreshWithForm(OAUTH_ENDPOINTS.qwen.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.qwen.clientId }, proxyOptions),
      iflow: () => this.refreshIflow(credentials.refreshToken, proxyOptions),
      gemini: () => this.refreshGoogle(credentials.refreshToken, proxyOptions),
      kiro: () => this.refreshKiro(credentials.refreshToken, proxyOptions),
      cline: () => this.refreshCline(credentials.refreshToken, proxyOptions),
      "kimi-coding": () => this.refreshKimiCoding(credentials.refreshToken, proxyOptions),
      kilocode: () => this.refreshKilocode(credentials.refreshToken, proxyOptions)
    };

    const refresher = refreshers[this.provider];
    if (!refresher) return null;

    try {
      const result = await refresher();
      if (result) log?.info?.("TOKEN", `${this.provider} refreshed`);
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `${this.provider} refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshWithJSON(url, body, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || body.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshWithForm(url, params, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams(params)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || params.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshIflow(refreshToken, proxyOptions = null) {
    const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.iflow.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Authorization": `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: PROVIDERS.iflow.clientId, client_secret: PROVIDERS.iflow.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshGoogle(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.config.clientId, client_secret: this.config.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKiro(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "kiro-cli/1.0.0" },
      body: JSON.stringify({ refreshToken })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || refreshToken, expiresIn: tokens.expiresIn };
  }

  async refreshCline(refreshToken, proxyOptions = null) {
    console.log('[DEBUG] Refreshing Cline token, refreshToken length:', refreshToken?.length);
    const response = await proxyAwareFetch("https://api.cline.bot/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" })
    }, proxyOptions);
    console.log('[DEBUG] Cline refresh response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.log('[DEBUG] Cline refresh error:', errorText);
      return null;
    }
    const payload = await response.json();
    console.log('[DEBUG] Cline refresh payload:', JSON.stringify(payload).substring(0, 200));
    const data = payload?.data || payload;
    const expiresAtIso = data?.expiresAt;
    const expiresIn = expiresAtIso ? Math.max(1, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000)) : undefined;
    console.log('[DEBUG] Cline refresh success, expiresIn:', expiresIn);
    return { accessToken: data?.accessToken, refreshToken: data?.refreshToken || refreshToken, expiresIn };
  }

  async refreshKimiCoding(refreshToken, proxyOptions = null) {
    const kimiHeaders = buildKimiHeaders();
    const response = await proxyAwareFetch("https://auth.kimi.com/api/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        ...kimiHeaders
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKilocode(refreshToken, proxyOptions = null) {
    // Kilocode uses device code flow, no refresh token support
    return null;
  }
}

export default DefaultExecutor;
