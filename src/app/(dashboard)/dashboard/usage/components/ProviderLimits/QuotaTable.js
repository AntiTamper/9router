"use client";

const WINDOW_MS = {
  session: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

function classifyQuota(label = "") {
  const text = String(label).toLowerCase();
  if (text.includes("session") || text.includes("5h") || text.includes("5-hour") || text.includes("five hour") || text.includes("five_hour")) return "session";
  if (text.includes("week")) return "weekly";
  if (text.includes("month")) return "monthly";
  return "generic";
}

function quotaLabel(label = "") {
  const kind = classifyQuota(label);
  if (kind === "session") return "Session Limit";
  if (kind === "weekly") return "Weekly Limit";
  if (kind === "monthly") return "Monthly Limit";
  return label || "Quota";
}

function inferResetTime(resetTime, label) {
  if (resetTime) return resetTime;
  const kind = classifyQuota(label);
  const ms = WINDOW_MS[kind];
  return ms ? new Date(Date.now() + ms).toISOString() : null;
}

function formatCountdown(resetTime) {
  if (!resetTime) return "";
  const diffMs = new Date(resetTime).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "00:00:00";
  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${String(days).padStart(2, "0")}:${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatResetDate(resetTime) {
  if (!resetTime) return "";
  const date = new Date(resetTime);
  if (!Number.isFinite(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day}, ${hour}:${minute}`;
}

function getColorClasses(remainingPercentage) {
  if (remainingPercentage >= 60) return { text: "text-green-600 dark:text-green-400", bg: "bg-green-500", track: "bg-green-500/10" };
  if (remainingPercentage > 20) return { text: "text-yellow-600 dark:text-yellow-400", bg: "bg-yellow-500", track: "bg-yellow-500/10" };
  return { text: "text-red-600 dark:text-red-400", bg: "bg-red-500", track: "bg-red-500/10" };
}

export function getQuotaRemaining(quota) {
  if (quota?.remainingPercentage !== undefined && quota?.remainingPercentage !== null) {
    return Math.max(0, Math.min(100, Math.round(quota.remainingPercentage)));
  }
  const total = Number(quota?.total || 0);
  if (!Number.isFinite(total) || total <= 0) return 100;
  const used = Number(quota?.used || 0);
  return Math.max(0, Math.min(100, Math.round(((total - used) / total) * 100)));
}

export function QuotaBarRow({ quota, label, bold = false }) {
  const remaining = getQuotaRemaining(quota);
  const resetTime = inferResetTime(quota?.resetAt, label || quota?.name);
  const hasReset = !!formatResetDate(resetTime);
  const colors = getColorClasses(remaining);
  const title = quotaLabel(label || quota?.name);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className={`${bold ? "font-semibold" : "font-medium"} text-text-primary`}>{title}</span>
        <span className={`font-semibold ${colors.text}`}>{remaining}%</span>
      </div>
      <div className={`h-1.5 overflow-hidden rounded-full ${colors.track}`}>
        <div
          className={`h-full rounded-full transition-all duration-300 ${colors.bg}`}
          style={{ width: `${remaining}%` }}
        />
      </div>
      {hasReset && (
        <div className="flex items-center justify-between gap-3 text-[11px] text-text-muted">
          <span>reset in {formatCountdown(resetTime)}</span>
          <span>{formatResetDate(resetTime)}</span>
        </div>
      )}
    </div>
  );
}

function orderQuotas(quotas) {
  const rank = { session: 0, weekly: 1, monthly: 2, generic: 3 };
  return [...quotas].sort((a, b) => rank[classifyQuota(a.name)] - rank[classifyQuota(b.name)]);
}

export default function QuotaTable({ quotas = [], compact = false }) {
  if (!quotas || quotas.length === 0) return null;

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {orderQuotas(quotas).map((quota, index) => (
        <QuotaBarRow key={`${quota.name || "quota"}-${index}`} quota={quota} />
      ))}
    </div>
  );
}