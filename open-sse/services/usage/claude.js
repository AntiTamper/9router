/**
 * Claude usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";

// Claude API config (urls from registry, apiVersion is header logic kept here)
const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  usageUrl: U("claude").orgUrl,
  settingsUrl: U("claude").settingsUrl,
  apiVersion: ANTHROPIC_API_VERSION,
};

// OAuth usage endpoint rate-limits (429); cool down per-token to stop hammering it.
// Only the quota endpoint is affected — chat with the same token still works.
const OAUTH_429_COOLDOWN_MS = 300000; // base 5 min cooldown when no Retry-After
const OAUTH_429_COOLDOWN_MAX_MS = 1800000; // cap honored Retry-After at 30 min
const oauthCooldown = new Map();
// Cache last successful OAuth usage payload per token so a transient 429 keeps
// showing real quota instead of N/A. Bounded + age-limited.
const LAST_KNOWN_MAX_AGE_MS = 86400000; // 24h
const lastKnownUsage = new Map();

function tokenKey(accessToken) {
  const t = String(accessToken || "");
  return t.length > 12 ? t.slice(-12) : t;
}

function rememberUsage(accessToken, usage) {
  if (!usage || !usage.quotas || Object.keys(usage.quotas).length === 0) return;
  lastKnownUsage.set(tokenKey(accessToken), { usage, at: Date.now() });
}

function recallUsage(accessToken) {
  const entry = lastKnownUsage.get(tokenKey(accessToken));
  if (!entry) return null;
  if (Date.now() - entry.at > LAST_KNOWN_MAX_AGE_MS) {
    lastKnownUsage.delete(tokenKey(accessToken));
    return null;
  }
  return entry.usage;
}

function rateLimitedResult(accessToken) {
  const recalled = recallUsage(accessToken);
  // Keep real quota bars when we have last-known data. Do NOT set `message`
  // here: the UI parser short-circuits on `message` and would hide the quotas.
  if (recalled && recalled.quotas && Object.keys(recalled.quotas).length > 0) {
    return { ...recalled, stale: true };
  }
  return { message: "Claude connected. Usage temporarily rate-limited, retrying shortly." };
}

function cooldownFromResponse(response) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, OAUTH_429_COOLDOWN_MAX_MS);
  }
  return OAUTH_429_COOLDOWN_MS;
}

export async function getClaudeUsage(accessToken, proxyOptions = null) {
  try {
    // Skip OAuth usage call while this token is cooling down from a recent 429
    const cooldownUntil = oauthCooldown.get(accessToken);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return rateLimitedResult(accessToken);
    }

    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    const oauthResponse = await proxyAwareFetch(CLAUDE_CONFIG.oauthUsageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      const result = {
        plan: "Claude Code",
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
      rememberUsage(accessToken, result);
      return result;
    }

    // OAuth usage is the correct endpoint for Claude Code consumer tokens. A 429
    // means rate-limited, NOT lack of permission — do not fall to the org/admin
    // legacy path (it produces a misleading "admin permissions" message). Cool
    // down, honor Retry-After, and keep showing last-known quota.
    if (oauthResponse.status === 429) {
      oauthCooldown.set(accessToken, Date.now() + cooldownFromResponse(oauthResponse));
      return rateLimitedResult(accessToken);
    }

    // Other non-OK statuses: token may be an org/API-key account — try legacy path.
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    return await getClaudeUsageLegacy(accessToken, proxyOptions);
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}
