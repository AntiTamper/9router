import { getModelsByProviderId } from "open-sse/config/providerModels.js";

/**
 * Format ISO date string to countdown format (inspired by vscode-antigravity-cockpit)
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted countdown (e.g., "2d 5h 30m", "4h 40m", "15m") or "-"
 */
export function formatResetTime(date) {
  if (!date) return "-";

  try {
    const resetDate = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = resetDate - now;

    if (diffMs <= 0) return "-";

    const totalMinutes = Math.ceil(diffMs / (1000 * 60));
    
    // < 60 minutes: show only minutes
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }
    
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    
    // < 24 hours: show hours and minutes
    if (totalHours < 24) {
      return `${totalHours}h ${remainingMinutes}m`;
    }
    
    // >= 24 hours: show days, hours, and minutes
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  } catch (error) {
    return "-";
  }
}

/**
 * Get Tailwind color class based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Color name: "green" | "yellow" | "red"
 */
export function getStatusColor(percentage) {
  if (percentage >= 60) return "green";
  if (percentage > 20) return "yellow";
  return "red";
}

/**
 * Get status emoji based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Emoji: "🟢" | "🟡" | "🔴"
 */
export function getStatusEmoji(percentage) {
  if (percentage >= 60) return "🟢";
  if (percentage > 20) return "🟡";
  return "🔴";
}

/**
 * Calculate remaining percentage
 * @param {number} used - Used amount
 * @param {number} total - Total amount
 * @returns {number} Remaining percentage (0-100)
 */
export function calculatePercentage(used, total) {
  if (!total || total === 0) return 0;
  if (!used || used < 0) return 100;
  if (used >= total) return 0;

  return Math.round(((total - used) / total) * 100);
}

function clampPercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function quotaRemainingPercentage(quota) {
  if (!quota || !quota.total || quota.total <= 0) return null;
  if (quota.remainingPercentage !== undefined) {
    return clampPercentage(quota.remainingPercentage);
  }
  return clampPercentage(calculatePercentage(quota.used, quota.total));
}

function isSessionQuotaRow(quota) {
  const label = String(
    quota?.name ?? quota?.label ?? quota?.window ?? quota?.type ?? "",
  ).toLowerCase();
  if (!label) return false;
  if (label.includes("weekly") || label.includes("daily")) return false;
  return (
    label.includes("session") ||
    label.includes("5h") ||
    label.includes("5-hour") ||
    label.includes("five_hour")
  );
}

function selectQuotaRowsForServiceAverage(quotas) {
  if (!Array.isArray(quotas) || quotas.length === 0) return [];
  const sessionRows = quotas.filter(isSessionQuotaRow);
  if (sessionRows.length > 0) return sessionRows;
  return quotas;
}

export function buildProviderQuotaAverages(
  connections = [],
  quotaData = {},
  options = {},
) {
  const groups = new Map();
  const loadingById = options.loadingById || {};
  const completedById = options.completedById || null;
  const hasCompletionTracking =
    completedById && typeof completedById === "object";

  for (const conn of connections) {
    if (!conn?.provider) continue;
    const group = groups.get(conn.provider) || {
      provider: conn.provider,
      accountCount: 0,
      activeCount: 0,
      measuredAccounts: 0,
      pendingCount: 0,
      exhaustedCount: 0,
      lowCount: 0,
      totalRemaining: 0,
      averageRemaining: null,
      isLoading: false,
    };

    group.accountCount += 1;
    if (conn.isActive !== false) group.activeCount += 1;

    const isPending =
      loadingById[conn.id] === true ||
      (hasCompletionTracking && completedById[conn.id] !== true);

    if (isPending) {
      group.pendingCount += 1;
      group.isLoading = true;
      groups.set(conn.provider, group);
      continue;
    }

    const quotas = selectQuotaRowsForServiceAverage(quotaData[conn.id]?.quotas || []);
    const percentages = quotas
      .map(quotaRemainingPercentage)
      .filter((percentage) => percentage !== null);

    if (percentages.length > 0) {
      const accountAverage = Math.round(
        percentages.reduce((sum, percentage) => sum + percentage, 0) / percentages.length,
      );
      group.measuredAccounts += 1;
      group.totalRemaining += accountAverage;
      if (accountAverage <= 0) group.exhaustedCount += 1;
      else if (accountAverage < 60) group.lowCount += 1;
    } else if (conn.quotaAutoDisabled) {
      group.exhaustedCount += 1;
    }

    groups.set(conn.provider, group);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      averageRemaining: group.isLoading
        ? null
        : group.measuredAccounts > 0
        ? Math.round(group.totalRemaining / group.measuredAccounts)
        : null,
    }))
    .sort((a, b) => {
      const aAvg = a.averageRemaining ?? Number.POSITIVE_INFINITY;
      const bAvg = b.averageRemaining ?? Number.POSITIVE_INFINITY;
      if (aAvg !== bAvg) return aAvg - bAvg;
      return a.provider.localeCompare(b.provider);
    });
}

/**
 * Parse provider-specific quota structures into normalized array
 * @param {string} provider - Provider name (github, antigravity, codex, kiro, claude)
 * @param {Object} data - Raw quota data from provider
 * @returns {Array<Object>} Normalized quota objects with { name, used, total, resetAt }
 */
export function parseQuotaData(provider, data) {
  if (!data || typeof data !== "object") return [];

  const normalizedQuotas = [];

  try {
    switch (provider.toLowerCase()) {
      case "github":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "antigravity":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([modelKey, quota]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey: modelKey, // Keep modelKey for sorting
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "codex":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            normalizedQuotas.push({
              name: quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "kiro":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            normalizedQuotas.push({
              name: quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "claude":
        if (data.message) {
          // Handle error message case
          normalizedQuotas.push({
            name: "error",
            used: 0,
            total: 0,
            resetAt: null,
            message: data.message,
          });
        } else if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      default:
        // Generic fallback for unknown providers
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
    }
  } catch (error) {
    console.error(`Error parsing quota data for ${provider}:`, error);
    return [];
  }

  // Sort quotas according to PROVIDER_MODELS order
  const modelOrder = getModelsByProviderId(provider);
  if (modelOrder.length > 0) {
    const orderMap = new Map(modelOrder.map((m, i) => [m.id, i]));
    
    normalizedQuotas.sort((a, b) => {
      // Use modelKey for antigravity, otherwise use name
      const keyA = a.modelKey || a.name;
      const keyB = b.modelKey || b.name;
      const orderA = orderMap.get(keyA) ?? 999;
      const orderB = orderMap.get(keyB) ?? 999;
      return orderA - orderB;
    });
  }

  return normalizedQuotas;
}
