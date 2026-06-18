/**
 * Google usage handlers (Gemini CLI + Antigravity)
 */

import { CLIENT_METADATA, getPlatformUserAgent } from "../../config/appConstants.js";
import { ANTIGRAVITY_OAUTH_CLIENT } from "../../providers/shared.js";
import { U, parseResetTime, normalizeCloudCodeProjectId, fetchWithTimeout } from "./shared.js";

// Antigravity API config (from Quotio) — urls from registry, oauth client + dynamic UA kept here
const ANTIGRAVITY_CONFIG = {
  ...U("antigravity"),
  ...ANTIGRAVITY_OAUTH_CLIENT,
  userAgent: getPlatformUserAgent(),
};

/**
 * Gemini CLI Usage — fetch per-model quota via Cloud Code Assist API.
 * Uses retrieveUserQuota (same endpoint as `gemini /stats`) returning
 * per-model buckets with remainingFraction + resetTime.
 */
export async function getGeminiUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { plan: "Free", message: "Gemini CLI access token not available." };
  }

  try {
    // Resolve project id: prefer connection-stored id, else loadCodeAssist lookup.
    // #1271: OAuth save stores projectId on the connection, not providerSpecificData.
    let projectId = normalizeCloudCodeProjectId(providerSpecificData?.projectId);
    let plan = "Free";

    if (!projectId) {
      const subInfo = await getGeminiSubscriptionInfo(accessToken, proxyOptions);
      projectId = normalizeCloudCodeProjectId(subInfo?.cloudaicompanionProject);
      plan = subInfo?.currentTier?.name || plan;
    }

    if (!projectId) {
      return {
        plan,
        message: "Gemini CLI project ID not available. Reconnect Gemini CLI, or configure a Google Cloud project with Gemini Code Assist access before checking quota.",
      };
    }

    const response = await fetchWithTimeout(
      U("gemini-cli").quotaUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: projectId }),
      },
      10000,
      proxyOptions
    );

    if (!response.ok) {
      return { plan, message: `Gemini CLI quota error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    if (Array.isArray(data.buckets)) {
      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;

        const remainingFraction = Number(bucket.remainingFraction) || 0;
        const total = 1000; // Normalized base, matches antigravity convention
        const remaining = Math.round(total * remainingFraction);
        const used = Math.max(0, total - remaining);

        quotas[bucket.modelId] = {
          used,
          total,
          resetAt: parseResetTime(bucket.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
        };
      }
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Gemini CLI error: ${error.message}` };
  }
}

/**
 * Get Gemini CLI subscription info via loadCodeAssist
 */
async function getGeminiSubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(
      U("gemini-cli").loadCodeAssistUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: CLIENT_METADATA }),
      },
      10000,
      proxyOptions
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Group antigravity models into UI families (matches dashboard cards).
// Gemini* -> "gemini" card; claude*/gpt* (and anything else) -> "claude_gpt" card.
function classifyAntigravityFamily(modelKey) {
  const key = String(modelKey || "").toLowerCase();
  if (key.startsWith("gemini")) return "gemini";
  return "claude_gpt";
}

// Derive the quota window for an antigravity bucket.
// Free-tier "Antigravity" plan exposes only a weekly window; paid tiers may
// also expose a five-hour window. Prefer an explicit window/limit hint from the
// API; otherwise infer from the reset horizon (>24h out => weekly, else 5h).
function classifyAntigravityWindow(quotaInfo, resetAt) {
  const hint = String(
    quotaInfo?.tokenType
      || quotaInfo?.quotaType
      || quotaInfo?.limitType
      || quotaInfo?.window
      || "",
  ).toLowerCase();
  if (hint.includes("week") || hint === "wtus" || hint.includes("7")) return "weekly";
  if (hint.includes("hour") || hint.includes("5h") || hint.includes("five")) return "five_hour";

  if (resetAt) {
    const ms = new Date(resetAt).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0 && ms <= 24 * 60 * 60 * 1000) return "five_hour";
  }
  return "weekly";
}

function getAntigravityQuotaEntries(info) {
  const source = info?.quotaInfos || info?.quotas || info?.quotaInfo;
  if (!source) return [];
  if (Array.isArray(source)) return source.map((quotaInfo, index) => [String(quotaInfo?.window || quotaInfo?.quotaType || index), quotaInfo]);
  if (source.remainingFraction != null || source.resetTime) return [[String(source.window || source.quotaType || "quota"), source]];
  if (typeof source === "object") return Object.entries(source).map(([key, quotaInfo]) => [key, quotaInfo]);
  return [];
}
/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.quotaApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": "1.107.0",
        "x-request-source": "local", // MITM bypass
      },
      body: JSON.stringify({
        ...(projectId ? { project: projectId } : {})
      }),
    }, 10000, proxyOptions);

    if (response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {}
      };
    }

    if (response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {}
      };
    }

    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    const quotas = {};

    // Parse model quotas (inspired by vscode-antigravity-cockpit)
    if (data.models) {
      // Filter only recommended/important models (must match PROVIDER_MODELS ag ids)
      const importantModels = [
        'gemini-3-flash-agent',
        'gemini-3.5-flash-low',
        'gemini-3.5-flash-extra-low',
        'gemini-pro-agent',
        'gemini-3.1-pro-low',
        'claude-sonnet-4-6',
        'claude-opus-4-6-thinking',
        'gpt-oss-120b-medium',
        'gemini-3-flash',
      ];

      for (const [modelKey, info] of Object.entries(data.models)) {
        // Skip internal models and non-important models
        if (info.isInternal || !importantModels.includes(modelKey)) {
          continue;
        }

        const quotaEntries = getAntigravityQuotaEntries(info);
        if (quotaEntries.length === 0) continue;

        for (const [bucketKey, quotaInfo] of quotaEntries) {
          const remainingFraction = quotaInfo?.remainingFraction || 0;
          const remainingPercentage = remainingFraction * 100;

          // Convert percentage to used/total for UI compatibility
          const total = 1000; // Normalized base
          const remaining = Math.round(total * remainingFraction);
          const used = total - remaining;
          const resetAt = parseResetTime(quotaInfo?.resetTime);
          const window = classifyAntigravityWindow({ ...(quotaInfo || {}), window: quotaInfo?.window || bucketKey }, resetAt);

          quotas[`${modelKey}:${window}`] = {
            used,
            total,
            resetAt,
            remainingPercentage,
            unlimited: false,
            displayName: info.displayName || modelKey,
            family: classifyAntigravityFamily(modelKey),
            window,
            modelKey,
          };
        }
      }
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "x-request-source": "local", // MITM bypass
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
    }, 10000, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  }
}
