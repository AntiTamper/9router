"use client";

import { QuotaBarRow } from "./QuotaTable";

// Family + window display metadata
const FAMILY_LABELS = {
  gemini: "Gemini Models",
  claude_gpt: "Claude and GPT models",
};
const FAMILY_ORDER = ["gemini", "claude_gpt"];

const WINDOW_LABELS = {
  weekly: "Weekly Limit",
  five_hour: "Five Hour Limit",
};
const WINDOW_ORDER = ["weekly", "five_hour"];

function formatResetTimeDisplay(resetTime) {
  if (!resetTime) return null;
  try {
    const date = new Date(resetTime);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let dayStr = "";
    if (date >= today && date < tomorrow) {
      dayStr = "Today";
    } else if (
      date >= tomorrow &&
      date < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)
    ) {
      dayStr = "Tomorrow";
    } else {
      dayStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${dayStr}, ${timeStr}`;
  } catch {
    return null;
  }
}

function getColorClasses(remainingPercentage) {
  if (remainingPercentage >= 60) {
    return { text: "text-green-600 dark:text-green-400", bg: "bg-green-500", bgLight: "bg-green-500/10" };
  }
  if (remainingPercentage > 20) {
    return { text: "text-yellow-600 dark:text-yellow-400", bg: "bg-yellow-500", bgLight: "bg-yellow-500/10" };
  }
  return { text: "text-red-600 dark:text-red-400", bg: "bg-red-500", bgLight: "bg-red-500/10" };
}

function remainingOf(quota) {
  if (quota.remainingPercentage !== undefined && quota.remainingPercentage !== null) {
    return Math.round(quota.remainingPercentage);
  }
  if (quota.total > 0) return Math.round(((quota.total - quota.used) / quota.total) * 100);
  return 0;
}

// Aggregate quotas into family -> window -> { remaining (min/worst-case), resetAt (earliest) }
function buildGroups(quotas) {
  const families = new Map();
  for (const quota of quotas) {
    const family = quota.family || "claude_gpt";
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

function WindowBar({ label, remaining, resetAt }) {
  return (
    <QuotaBarRow
      bold
      label={label}
      quota={{ name: label, remainingPercentage: remaining, resetAt, total: 100, used: 100 - remaining }}
    />
  );
}

/**
 * Antigravity grouped quota display: one card per model family
 * (Gemini Models / Claude and GPT models), each with the available
 * windows (Weekly always; Five Hour only when present on the plan).
 */
export default function QuotaTableGrouped({ quotas = [] }) {
  if (!quotas || quotas.length === 0) return null;

  const families = buildGroups(quotas);
  const presentFamilies = FAMILY_ORDER.filter((f) => families.has(f));
  const extraFamilies = Array.from(families.keys()).filter((f) => !FAMILY_ORDER.includes(f));
  const orderedFamilies = [...presentFamilies, ...extraFamilies];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {orderedFamilies.map((family) => {
        const windows = families.get(family);
        const orderedWindows = [
          ...WINDOW_ORDER.filter((w) => windows.has(w)),
          ...Array.from(windows.keys()).filter((w) => !WINDOW_ORDER.includes(w)),
        ];
        return (
          <div
            key={family}
            className="rounded-xl border border-black/5 dark:border-white/5 bg-black/[0.015] dark:bg-white/[0.015] p-3 space-y-3"
          >
            <div className="text-sm font-semibold text-text-primary">
              {FAMILY_LABELS[family] || family}
            </div>
            <div className="space-y-3">
              {orderedWindows.map((win) => {
                const data = windows.get(win);
                return (
                  <WindowBar
                    key={win}
                    label={WINDOW_LABELS[win] || win}
                    remaining={data.remaining}
                    resetAt={data.resetAt}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
