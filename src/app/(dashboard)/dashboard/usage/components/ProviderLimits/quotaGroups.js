// Pure quota grouping helpers (no React/JSX) so they can be unit-tested directly.

export const WINDOW_ORDER = ["five_hour", "weekly"];

export function remainingOf(quota) {
  if (quota.remainingPercentage !== undefined && quota.remainingPercentage !== null) {
    return Math.round(quota.remainingPercentage);
  }
  if (quota.total > 0) return Math.round(((quota.total - quota.used) / quota.total) * 100);
  return 0;
}

function inferFamily(quota) {
  if (quota?.family) return quota.family;

  const key = String(quota?.modelKey || quota?.name || "").toLowerCase();
  if (key.startsWith("all:") || key.includes("all model")) return "all";
  if (key.startsWith("gemini:") || key.includes("gemini")) return "gemini";
  return "claude_gpt";
}

// Aggregate quotas into family -> window -> { remaining (min/worst-case), resetAt (earliest) }.
// Render ONLY windows we actually have data for. The upstream Antigravity API returns a
// single quota window per model (classified five_hour vs weekly by its reset horizon); the
// other window is simply unknown. Inventing a missing window as 100% fabricates quota the
// user never had, so we never infer/fill here.
export function buildGroups(quotas) {
  const families = new Map();
  for (const quota of quotas) {
    const family = inferFamily(quota);
    const win = quota.window || "weekly";
    if (!families.has(family)) families.set(family, new Map());
    const windows = families.get(family);

    const remaining = remainingOf(quota);
    const resetMs = quota.resetAt ? new Date(quota.resetAt).getTime() : null;
    const existing = windows.get(win);
    if (!existing) {
      windows.set(win, { remaining, resetAt: quota.resetAt || null, resetMs });
    } else {
      if (remaining < existing.remaining) existing.remaining = remaining;
      if (resetMs && (existing.resetMs == null || resetMs < existing.resetMs)) {
        existing.resetMs = resetMs;
        existing.resetAt = quota.resetAt;
      }
    }
  }
  return families;
}
