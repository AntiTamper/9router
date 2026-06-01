// Display formatting helpers shared by the public /apikey page and the
// dashboard key-management GUI. Pure functions, no side effects.

const numberFormatter = new Intl.NumberFormat("en-US");

// 100000000 -> "100,000,000". Non-finite -> "0".
export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return numberFormatter.format(Math.round(n));
}

// Token count with an em dash for unlimited (null/undefined limit).
export function formatLimit(limit) {
  if (limit === null || limit === undefined) return "Unlimited";
  return formatNumber(limit);
}

// ISO -> local short date+time, "—" when absent.
export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

// ISO -> local date only.
export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

// Compact relative duration until an ISO timestamp ("in 3h", "2d ago").
export function formatRelative(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const future = diff >= 0;
  let label;
  if (mins < 1) label = "just now";
  else if (mins < 60) label = `${mins}m`;
  else if (mins < 1440) label = `${Math.round(mins / 60)}h`;
  else label = `${Math.round(mins / 1440)}d`;
  if (label === "just now") return label;
  return future ? `in ${label}` : `${label} ago`;
}

// Convert ISO -> value usable by <input type="datetime-local"> (local tz).
export function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Convert a <input type="datetime-local"> value -> ISO string (local tz).
export function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}