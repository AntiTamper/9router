import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  getApiKeyAccess,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { resolveExposure, isModelAllowed, effectiveTokenSaver, effectiveCustomInstruction } from "@/lib/keyPolicy.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse, isLocalProxyFailure, isTerminalClientError } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";

const MAX_ACCOUNT_FALLBACK_ATTEMPTS = Math.max(1, parseInt(process.env.MAX_ACCOUNT_FALLBACK_ATTEMPTS || "3", 10));
// Hard cap on inbound request body to bound memory use / payload-flood DoS.
// Generous default (LLM payloads carry large base64 images / long contexts);
// override via env. 50MB headroom avoids truncating legitimate multimodal/big
// requests while still bounding abuse (see #1572).
const MAX_REQUEST_BODY_BYTES = Math.max(
  64 * 1024,
  parseInt(process.env.MAX_REQUEST_BODY_BYTES || String(50 * 1024 * 1024), 10),
);
const ACCOUNT_FALLBACK_DEADLINE_MS = Math.max(1000, parseInt(process.env.ACCOUNT_FALLBACK_DEADLINE_MS || "45000", 10));

function rawRequestForComboPanel(clientRawRequest) {
  if (!clientRawRequest?.body) return clientRawRequest;
  const body = { ...clientRawRequest.body };
  delete body.tools;
  delete body.tool_choice;
  return { ...clientRawRequest, body };
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  const declaredLength = parseInt(request.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    log.warn("CHAT", `Request body too large: ${declaredLength} bytes`);
    return errorResponse(413, "Request body too large");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce required keys, and always enforce limits for provided keys.
  const settings = await getSettings();
  if (settings.requireApiKey && !apiKey) {
    log.warn("AUTH", "Missing API key (requireApiKey=true)");
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  }
  let keyConfig = null;
  if (apiKey) {
    const access = await getApiKeyAccess(apiKey);
    if (!access.valid) {
      const reason = access.reason || "invalid";
      log.warn("AUTH", `Rejected API key (${reason})`);
      if (reason === "token_limit_exceeded") {
        const reset = access.resetAt ? ` Resets at ${access.resetAt}.` : "";
        return errorResponse(HTTP_STATUS.RATE_LIMITED, `API key token limit exhausted.${reset}`);
      }
      if (reason === "expired") {
        return errorResponse(HTTP_STATUS.UNAUTHORIZED, "API key expired");
      }
      if (reason === "paused") {
        return errorResponse(HTTP_STATUS.UNAUTHORIZED, "API key paused");
      }
      if (reason === "outside_authorized_hours") {
        return errorResponse(HTTP_STATUS.FORBIDDEN, "API key not authorized at this time");
      }
      if (reason === "not_yet_available") {
        return errorResponse(HTTP_STATUS.FORBIDDEN, "API key not yet available");
      }
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
    keyConfig = access.key?.config || null;
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Enforce per-key model/combo exposure (global default + per-key override).
  if (keyConfig) {
    const exposure = resolveExposure(keyConfig, settings);
    if (exposure.mode !== "all") {
      const requestedCombo = await getComboModels(modelStr);
      const isCombo = requestedCombo !== null;
      const allowedComboMembers = exposure.mode === "combo" && exposure.combo
        ? await getComboModels(exposure.combo)
        : null;
      if (!isModelAllowed(exposure, { modelStr, isCombo, allowedComboMembers })) {
        log.warn("AUTH", `Model ${modelStr} not exposed for this API key`);
        return errorResponse(HTTP_STATUS.FORBIDDEN, "Model not permitted for this API key");
      }
    }
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => handleSingleModelChat(
          b,
          m,
          isPanel ? rawRequestForComboPanel(clientRawRequest) : clientRawRequest,
          request,
          apiKey,
          keyConfig
        ),
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, keyConfig),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, keyConfig);
}

/**
 * Handle single model chat request
 */
const MAX_COMBO_DEPTH = 3;

async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, keyConfig = null, comboDepth = 0) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Guard against combo-of-combo loops / unbounded recursion.
      if (comboDepth >= MAX_COMBO_DEPTH) {
        log.warn("COMBO", `Combo nesting too deep (>${MAX_COMBO_DEPTH}) at "${modelStr}"`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, "Combo nesting too deep");
      }
      const chatSettings = await getSettings();
      // Re-check per-key exposure for this (nested) combo: the top-level guard
      // only validated the originally requested model, not combos referenced
      // by other combos.
      if (keyConfig) {
        const exposure = resolveExposure(keyConfig, chatSettings);
        if (exposure.mode !== "all") {
          const allowedComboMembers = exposure.mode === "combo" && exposure.combo
            ? await getComboModels(exposure.combo)
            : null;
          if (!isModelAllowed(exposure, { modelStr, isCombo: true, allowedComboMembers })) {
            log.warn("AUTH", `Nested combo ${modelStr} not exposed for this API key`);
            return errorResponse(HTTP_STATUS.FORBIDDEN, "Model not permitted for this API key");
          }
        }
      }
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => handleSingleModelChat(
            b,
            m,
            isPanel ? rawRequestForComboPanel(clientRawRequest) : clientRawRequest,
            request,
            apiKey,
            keyConfig,
            comboDepth + 1
          ),
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, keyConfig, comboDepth + 1),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  const fallbackStartMs = Date.now();

  while (true) {
    if (excludeConnectionIds.size >= MAX_ACCOUNT_FALLBACK_ATTEMPTS || Date.now() - fallbackStartMs > ACCOUNT_FALLBACK_DEADLINE_MS) {
      const attempted = excludeConnectionIds.size;
      const reason = attempted >= MAX_ACCOUNT_FALLBACK_ATTEMPTS
        ? `account fallback capped after ${attempted} attempt${attempted === 1 ? "" : "s"}`
        : `account fallback deadline ${ACCOUNT_FALLBACK_DEADLINE_MS}ms exceeded`;
      log.warn("CHAT", `${provider}/${model} ${reason}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError ? `${lastError} (${reason})` : reason);
    }

    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    // Effective token saver: per-key when tokenSaverMode=individual, else global.
    const saver = effectiveTokenSaver(chatSettings, keyConfig);
    const customInstruction = effectiveCustomInstruction(chatSettings, keyConfig);
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      codexUsageEnabled: saver.codexUsageEnabled,
      rtkEnabled: saver.rtkEnabled,
      toonEnabled: saver.toonEnabled,
      cavemanEnabled: saver.cavemanEnabled,
      cavemanLevel: saver.cavemanLevel,
      customInstructionEnabled: customInstruction.enabled,
      customInstructionText: customInstruction.text,
      customInstructionMode: customInstruction.mode,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    if (isLocalProxyFailure(result.status, result.error)) {
      log.warn("CHAT", `Local proxy failure for ${provider}/${model}; not locking account: ${result.error}`);
      return result.response;
    }

    // Content-moderation / safety refusals are input-deterministic: every account refuses
    // identically. Skip account fallback so we surface the refusal immediately without
    // wasting attempts or cooling down healthy accounts.
    if (!result.skipAccountFallback && isTerminalClientError(result.status, result.error)) {
      result.skipAccountFallback = true;
    }

    if (result.skipAccountFallback) {
      log.warn("CHAT", `Non-account failure for ${provider}/${model}; not locking account: ${result.error}`);
      return result.response;
    }

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
