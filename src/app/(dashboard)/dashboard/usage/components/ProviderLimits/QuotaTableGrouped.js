"use client";

import { QuotaBarRow } from "./QuotaTable";
import { buildGroups, WINDOW_ORDER } from "./quotaGroups";

// Family + window display metadata
const FAMILY_LABELS = {
  all: "All Models",
  gemini: "Gemini Models",
  claude_gpt: "Claude and GPT models",
};
const FAMILY_ORDER = ["all", "gemini", "claude_gpt"];

const WINDOW_LABELS = {
  five_hour: "Session Limit",
  weekly: "Weekly Limit",
};

export { buildGroups };

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
