"use client";

import { QuotaBarRow } from "./QuotaTable";

// Family + window display metadata
const FAMILY_LABELS = {
  gemini: "Gemini Models",
  claude_gpt: "Claude and GPT models",
};
const FAMILY_ORDER = ["gemini", "claude_gpt"];

const WINDOW_LABELS = {
  five_hour: "Session Limit",
  weekly: "Weekly Limit",
};
const WINDOW_ORDER = ["five_hour", "weekly"];
const WINDOW_MS = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function remainingOf(quota) {
  if (quota.remainingPercentage !== undefined && quota.remainingPercentage !== null) {
    return Math.round(quota.remainingPercentage);
  }
  if (quota.total > 0) return Math.round(((quota.total - quota.used) / quota.total) * 100);
  return 0;
}

// Aggregate quotas into family -> window -> { remaining (min/worst-case), resetAt (earliest) }
export function buildGroups(quotas, metadata = {}) {
  const families = new Map();
  let supportsSessionQuota = metadata?.supportsSessionQuota === true;
  for (const quota of quotas) {
    const family = quota.family || "claude_gpt";
    const win = quota.window || "weekly";
    if (quota.supportsSessionQuota === true || win === "five_hour") supportsSessionQuota = true;
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
  const presentWindows = new Set();
  for (const windows of families.values()) {
    for (const win of windows.keys()) presentWindows.add(win);
  }
  const accountWindows = supportsSessionQuota || presentWindows.has("five_hour")
    ? ["five_hour", "weekly"]
    : ["weekly"];

  for (const family of FAMILY_ORDER) {
    if (!families.has(family)) continue;
    const windows = families.get(family);
    for (const win of accountWindows) {
      if (!windows.has(win)) {
        const resetMs = Date.now() + WINDOW_MS[win];
        windows.set(win, {
          remaining: 100,
          resetAt: new Date(resetMs).toISOString(),
          resetMs,
          inferred: true,
        });
      }
    }
    for (const win of Array.from(windows.keys())) {
      if (!accountWindows.includes(win)) windows.delete(win);
    }
  }
  return families;
}

function formatCreditAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

function CreditSummary({ credits }) {
  const amount = formatCreditAmount(credits?.amount);
  if (!amount) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-black/5 dark:border-white/5 bg-black/[0.015] dark:bg-white/[0.015] px-3 py-2 text-sm">
      <span className="font-semibold text-text-primary">Available AI Credits</span>
      <span className="font-semibold text-text-primary">{amount}</span>
    </div>
  );
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
export default function QuotaTableGrouped({ quotas = [], metadata = {} }) {
  if (!quotas || quotas.length === 0) return null;

  const families = buildGroups(quotas, metadata);
  const presentFamilies = FAMILY_ORDER.filter((f) => families.has(f));
  const extraFamilies = Array.from(families.keys()).filter((f) => !FAMILY_ORDER.includes(f));
  const orderedFamilies = [...presentFamilies, ...extraFamilies];

  return (
    <div className="space-y-3">
      <CreditSummary credits={metadata?.aiCredits} />
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
    </div>
  );
}
