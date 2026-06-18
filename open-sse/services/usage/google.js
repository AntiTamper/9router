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
// Map an Antigravity grouped-quota group displayName to a UI family.
function classifyAntigravityGroupFamily(group) {
  const name = String(group?.displayName || group?.groupId || "").toLowerCase();
  if (name.includes("gemini")) return "gemini";
  return "claude_gpt";
}

// Map a grouped-quota bucket window string ("weekly" | "5h" | "five_hour" | ...) to our window id.
function classifyAntigravityBucketWindow(bucket) {
  const w = String(bucket?.window || bucket?.bucketId || bucket?.displayName || "").toLowerCase();
  if (w.includes("week")) return "weekly";
  if (w.includes("5h") || w.includes("five") || w.includes("hour")) return "five_hour";
  return "weekly";
}

/**
 * Parse the Antigravity grouped-quota response (groups[].buckets[]) into our
 * quotas map. This is the authoritative source the IDE dashboard uses and the
 * ONLY one that exposes real weekly AND five-hour remaining fractions.
 * Shape: { response: { groups: [ { displayName, buckets: [ { window, remainingFraction, resetTime, displayName } ] } ] } }
 */
export function parseGroupedAntigravityQuota(payload) {
  const root = payload?.response || payload || {};
  const groups = Array.isArray(root.groups) ? root.groups : [];
  const quotas = {};
  for (const group of groups) {
    const family = classifyAntigravityGroupFamily(group);
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      const window = classifyAntigravityBucketWindow(bucket);
      const frac = Number(bucket?.remainingFraction);
      const remainingFraction = Number.isFinite(frac) ? Math.min(Math.max(frac, 0), 1) : 0;
      const remainingPercentage = remainingFraction * 100;
      const total = 1000;
      const remaining = Math.round(total * remainingFraction);
      const used = total - remaining;
      const key = `${family}:${window}`;
      quotas[key] = {
        used,
        total,
        resetAt: parseResetTime(bucket?.resetTime),
        remainingPercentage,
        unlimited: false,
        displayName: group?.displayName || family,
        family,
        window,
        modelKey: bucket?.bucketId || key,
        description: bucket?.description || group?.description || null,
      };
    }
  }
  return quotas;
}
// Try the grouped quota endpoint (authoritative weekly + 5-hour fractions).
// Returns a quotas map on success, or null when unavailable so the caller can
// fall back to the per-model fetchAvailableModels path. The grouped response
// uses grpc-web+json; we request JSON and tolerate either {response:{groups}} or {groups}.
async function fetchGroupedAntigravityQuota(accessToken, projectId, proxyOptions) {
  const url = ANTIGRAVITY_CONFIG.groupedQuotaApiUrl;
  if (!url) return null;
  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": "1.107.0",
        "x-request-source": "local",
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    }, 10000, proxyOptions);
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data) return null;
    const groups = data?.response?.groups || data?.groups;
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const quotas = parseGroupedAntigravityQuota(data);
    return Object.keys(quotas).length > 0 ? quotas : null;
  } catch {
    return null;
  }
}
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    // Prefer the grouped quota endpoint (real weekly + 5-hour). Fall back to the
    // per-model availability path below when it is unavailable.
    const groupedQuotas = await fetchGroupedAntigravityQuota(accessToken, projectId, proxyOptions);
    if (groupedQuotas) {
      return {
        plan: subscriptionInfo?.currentTier?.name || "Unknown",
        quotas: groupedQuotas,
        subscriptionInfo,
      };
    }

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
