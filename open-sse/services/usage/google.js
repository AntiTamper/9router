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
  if (!url) return { error: { status: 0, message: "Antigravity quota endpoint not configured." } };
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
      body: "{}", // confirmed: retrieveUserQuotaSummary takes empty request body (project field => 400)
    }, 10000, proxyOptions);
    if (!response.ok) {
      let apiMsg = null;
      try { apiMsg = (await response.json())?.error?.message || null; } catch { /* ignore */ }
      return { error: { status: response.status, message: apiMsg } };
    }
    const data = await response.json().catch(() => null);
    if (!data) return { error: { status: response.status, message: "Empty quota response." } };
    const groups = data?.response?.groups || data?.groups;
    if (!Array.isArray(groups) || groups.length === 0) {
      return { error: { status: response.status, message: "No quota groups returned." } };
    }
    const quotas = parseGroupedAntigravityQuota(data);
    if (Object.keys(quotas).length === 0) {
      return { error: { status: response.status, message: "No quota buckets returned." } };
    }
    return { quotas };
  } catch (err) {
    return { error: { status: 0, message: err?.message || "network error" } };
  }
}

// Map a grouped-quota failure into a single honest, user-facing message.
// The per-model fetchAvailableModels endpoint only reports model AVAILABILITY
// (always remainingFraction=1), never real consumption, so it must NOT be used
// to synthesize quota bars. When the authoritative grouped endpoint is
// unavailable we surface the reason instead of fabricating 100% bars.
function antigravityQuotaUnavailableMessage(error) {
  const status = error?.status;
  const apiMsg = error?.message;
  if (status === 403) {
    if (apiMsg && /verify your account/i.test(apiMsg)) return "Antigravity account not verified — quota unavailable. Chat may still work.";
    if (apiMsg && /valid license/i.test(apiMsg)) return "Antigravity account has no quota license — quota unavailable. Chat may still work.";
    return "Antigravity quota not available for this account. Chat may still work.";
  }
  if (status === 401) return "Antigravity authentication expired — reconnect to view quota.";
  if (status === 429) return "Antigravity quota temporarily rate-limited. Try again later.";
  if (status && status >= 500) return `Antigravity quota service error (${status}). Try again later.`;
  return "Antigravity quota unavailable. Chat may still work.";
}
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    // The grouped quota endpoint (retrieveUserQuotaSummary) is the ONLY source of
    // real weekly + 5-hour remaining fractions. The per-model fetchAvailableModels
    // endpoint reports model AVAILABILITY (always remainingFraction=1), so it can
    // never be turned into honest quota bars. When grouped is unavailable we return
    // a clear message instead of fabricating 100% bars.
    const grouped = await fetchGroupedAntigravityQuota(accessToken, projectId, proxyOptions);
    if (grouped?.quotas) {
      return {
        plan: subscriptionInfo?.currentTier?.name || "Unknown",
        quotas: grouped.quotas,
        subscriptionInfo,
      };
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      message: antigravityQuotaUnavailableMessage(grouped?.error),
      quotas: {},
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
