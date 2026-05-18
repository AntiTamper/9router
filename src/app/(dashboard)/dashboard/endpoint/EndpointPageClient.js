"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Modal, CardSkeleton, Toggle, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const TUNNEL_BENEFITS = [
  { icon: "public", title: "Access Anywhere", desc: "Use your API from any network" },
  { icon: "group", title: "Share Endpoint", desc: "Share URL with team members" },
  { icon: "code", title: "Use in Cursor/Cline", desc: "Connect AI tools remotely" },
  { icon: "lock", title: "Encrypted", desc: "End-to-end TLS via Cloudflare" },
];

const TUNNEL_PING_INTERVAL_MS = 2000;
const TUNNEL_PING_MAX_MS = 300000;
const STATUS_POLL_FAST_MS = 5000;
const STATUS_POLL_SLOW_MS = 30000;
const REACHABLE_MISS_THRESHOLD = 5;
const CLIENT_PING_FAST_MS = 10000;
const CLIENT_PING_SLOW_MS = 60000;
const CLIENT_PING_TIMEOUT_MS = 5000;

// Browser-side health probe: bypasses backend DNS issues (1.1.1.1 vs OS resolver).
// Uses no-cors → opaque response means TLS+DNS reach succeeded, which is enough.
async function clientPingUrl(url) {
  if (!url) return false;
  try {
    await fetch(`${url}/api/health`, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(CLIENT_PING_TIMEOUT_MS),
    });
    return true;
  } catch { return false; }
}

const CAVEMAN_MODES = [
  { id: "normal", label: "Normal", desc: "Terse English output" },
  { id: "wenyan", label: "Wenyan", desc: "Classical concise Chinese" },
];

const CAVEMAN_INTENSITIES = [
  { id: "lite", label: "Lite", desc: "Drop filler, keep grammar" },
  { id: "full", label: "Full", desc: "Drop articles, fragments OK" },
  { id: "ultra", label: "Ultra", desc: "Telegraphic, max compression" },
];

const CAVEMAN_INTENSITY_IDS = new Set(CAVEMAN_INTENSITIES.map((item) => item.id));

function getCavemanSelection(level) {
  const raw = typeof level === "string" ? level : "full";
  if (raw.startsWith("wenyan-")) {
    const intensity = raw.slice("wenyan-".length);
    return {
      mode: "wenyan",
      intensity: CAVEMAN_INTENSITY_IDS.has(intensity) ? intensity : "full",
    };
  }
  return {
    mode: "normal",
    intensity: CAVEMAN_INTENSITY_IDS.has(raw) ? raw : "full",
  };
}

function toCavemanLevel({ mode, intensity }) {
  const safeIntensity = CAVEMAN_INTENSITY_IDS.has(intensity) ? intensity : "full";
  return mode === "wenyan" ? `wenyan-${safeIntensity}` : safeIntensity;
}

const API_KEY_LIMIT_MODES = [
  { id: "unlimited", label: "Unlimited" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "daily_weekly", label: "Daily + Weekly" },
  { id: "hard", label: "Hard cap" },
];

const DUAL_LIMIT_MODE = "daily_weekly";

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatCompactDateTime(value) {
  if (!value) return "Permanent";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Invalid";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatKeyReset(value) {
  if (!value) return "No reset";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "No reset";
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "Reset due";
  const minutes = Math.ceil(diffMs / 60000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return `resets in ${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
}

function keyStatusMeta(status) {
  if (status === "exhausted") return { label: "Exhausted", className: "text-red-600 dark:text-red-400 bg-red-500/10" };
  if (status === "expired") return { label: "Expired", className: "text-red-600 dark:text-red-400 bg-red-500/10" };
  if (status === "paused") return { label: "Paused", className: "text-orange-600 dark:text-orange-400 bg-orange-500/10" };
  return { label: "Active", className: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10" };
}

function formatTokens(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function getUsagePeriod(usage = {}, period) {
  return usage.periods?.[period] || { used: 0, requests: 0, resetAt: null };
}

function clampPercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function usageProgress(key, usage = {}) {
  const limit = usage.limit ?? key.tokenLimit ?? null;
  const used = usage.used ?? 0;
  const remaining = limit ? Math.max(0, limit - used) : null;
  const remainingPercentage = limit
    ? clampPercentage(usage.remainingPercentage ?? ((remaining / limit) * 100))
    : null;
  return {
    limit,
    used,
    remaining,
    remainingPercentage,
  };
}

function getLimitProgress(key, usage, period) {
  const limit = usage.limits?.[period]?.limit ?? (
    key.limitMode === DUAL_LIMIT_MODE
      ? (period === "daily" ? key.dailyTokenLimit : key.weeklyTokenLimit)
      : key.limitMode === period
        ? key.tokenLimit
        : null
  );
  const periodUsage = usage.limits?.[period] || getUsagePeriod(usage, period);
  const used = periodUsage.used ?? 0;
  const remaining = limit ? Math.max(0, limit - used) : null;
  const remainingPercentage = limit
    ? clampPercentage(periodUsage.remainingPercentage ?? ((remaining / limit) * 100))
    : null;
  return {
    limit,
    used,
    remaining,
    resetAt: periodUsage.resetAt,
    remainingPercentage,
  };
}

function barTone(remainingPercentage, exhausted = false) {
  const remaining = clampPercentage(remainingPercentage);
  if (exhausted || remaining <= 20) return "bg-red-500";
  if (remaining < 60) return "bg-yellow-500";
  return "bg-green-500";
}

function UsageStatBox({ label, value, hint, tone = "default" }) {
  const toneClass = tone === "warning"
    ? "border-orange-500/20 bg-orange-500/5"
    : tone === "danger"
      ? "border-red-500/20 bg-red-500/5"
      : "border-border-subtle bg-bg";
  return (
    <div className={`rounded-[10px] border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] font-medium uppercase text-text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold text-text-main">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-muted truncate">{hint}</p>}
    </div>
  );
}

function getLimitModeLabel(mode) {
  return API_KEY_LIMIT_MODES.find((item) => item.id === mode)?.label || "Unlimited";
}

function ApiKeyUsageBar({ apiKey, className = "" }) {
  const usage = apiKey.usage || {};
  const active = usageProgress(apiKey, usage);
  const remainingPercentage = active.limit ? active.remainingPercentage : 0;
  const tone = active.limit ? barTone(remainingPercentage, apiKey.status === "exhausted") : "bg-primary";
  const resetText = apiKey.limitMode === "daily" || apiKey.limitMode === "weekly"
    ? formatKeyReset(usage.resetAt)
    : "no reset";
  const isDual = apiKey.limitMode === DUAL_LIMIT_MODE;
  const dailyLimit = getLimitProgress(apiKey, usage, "daily");
  const weeklyLimit = getLimitProgress(apiKey, usage, "weekly");
  const renderLine = (label, item) => {
    const percentage = item.limit ? item.remainingPercentage : 0;
    const lineTone = item.limit ? barTone(percentage, apiKey.status === "exhausted") : "bg-primary";
    return (
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
          <span>{label}</span>
          <span>{item.limit ? `${formatTokens(item.remaining)} / ${formatTokens(item.limit)} left` : "unlimited"}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
          <div className={`h-full ${lineTone}`} style={{ width: `${percentage}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-text-muted">
          <span>{item.limit ? `${percentage}% remaining` : "unlimited"}</span>
          <span>{formatKeyReset(item.resetAt)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className={`w-full min-w-0 rounded-[10px] border border-border-subtle bg-surface px-3 py-2 ${className}`}>
      <div className="mb-1 flex min-w-0 items-start justify-between gap-3 text-[11px] text-text-muted sm:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-text-main">{apiKey.name}</span>
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
            {getLimitModeLabel(apiKey.limitMode)}
          </span>
        </div>
        {!isDual && (
          <span className="shrink-0 text-right">
            {active.limit ? `${formatTokens(active.remaining)} / ${formatTokens(active.limit)} left` : "unlimited"}
          </span>
        )}
      </div>
      {isDual ? (
        <>
          {renderLine("Daily limit", dailyLimit)}
          {renderLine("Weekly limit", weeklyLimit)}
        </>
      ) : (
        <>
          <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
            <div className={`h-full ${tone}`} style={{ width: `${remainingPercentage}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
            <span>{active.limit ? `${remainingPercentage}% remaining` : "unlimited"}</span>
            <span>{resetText}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function APIPageClient({ machineId }) {
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showKeyManager, setShowKeyManager] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyLimitMode, setNewKeyLimitMode] = useState("unlimited");
  const [newKeyTokenLimit, setNewKeyTokenLimit] = useState("");
  const [newKeyDailyTokenLimit, setNewKeyDailyTokenLimit] = useState("");
  const [newKeyWeeklyTokenLimit, setNewKeyWeeklyTokenLimit] = useState("");
  const [newKeyExpiresInHours, setNewKeyExpiresInHours] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [settingsKeyId, setSettingsKeyId] = useState(null);
  const [keyEdits, setKeyEdits] = useState({});
  const [savingKeyId, setSavingKeyId] = useState(null);

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [toonEnabled, setToonEnabled] = useState(false);

  // Cloudflare Tunnel state
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelReachable, setTunnelReachable] = useState(false);
  const [tunnelCanClientPing, setTunnelCanClientPing] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelProgress, setTunnelProgress] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [showEnableTunnelModal, setShowEnableTunnelModal] = useState(false);
  const [showDisableTunnelModal, setShowDisableTunnelModal] = useState(false);

  // Tailscale state
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsReachable, setTsReachable] = useState(false);
  const [tsCanClientPing, setTsCanClientPing] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [tsLoading, setTsLoading] = useState(false);
  const [tsProgress, setTsProgress] = useState("");
  const [tsStatus, setTsStatus] = useState(null);
  const [tsAuthUrl, setTsAuthUrl] = useState("");
  const [tsAuthLabel, setTsAuthLabel] = useState("");
  const [tsInstalled, setTsInstalled] = useState(null); // null=checking, true/false
  const [tsInstalling, setTsInstalling] = useState(false);
  const [tsInstallLog, setTsInstallLog] = useState([]);
  const [tsSudoPassword, setTsSudoPassword] = useState("");
  const [tsConnecting, setTsConnecting] = useState(false);
  const [showTsModal, setShowTsModal] = useState(false);
  const [showDisableTsModal, setShowDisableTsModal] = useState(false);
  const tsLogRef = useRef(null);

  // Debounce reachable=false: server may briefly return false during background refresh.
  // Only flip UI to "reconnecting" after N consecutive misses to avoid spinner flicker.
  const tunnelMissRef = useRef(0);
  const tsMissRef = useRef(0);
  // Browser-side reachable cache (independent of backend DNS quirks)
  const tunnelClientReachableRef = useRef(false);
  const tsClientReachableRef = useRef(false);
  // Track whether reachable=true was ever observed in this session.
  // Distinguishes "Checking..." (initial cold cache) from "Reconnecting..." (lost connection).
  const tunnelEverReachableRef = useRef(false);
  const tsEverReachableRef = useRef(false);
  const [tunnelEverReachable, setTunnelEverReachable] = useState(false);
  const [tsEverReachable, setTsEverReachable] = useState(false);

  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

  const { copied, copy } = useCopyToClipboard();

  // Auto-scroll install log
  useEffect(() => {
    if (tsLogRef.current) tsLogRef.current.scrollTop = tsLogRef.current.scrollHeight;
  }, [tsInstallLog]);

  useEffect(() => {
    fetchData();
    loadSettings();
  }, []);

  // Adaptive status poll: slow when healthy, fast when degraded; pause when tab hidden.
  useEffect(() => {
    const anyEnabled = tunnelEnabled || tsEnabled;
    if (!anyEnabled) return;
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    const delay = allHealthy ? STATUS_POLL_SLOW_MS : STATUS_POLL_FAST_MS;
    let timer = null;
    const tick = () => { if (!document.hidden) syncTunnelStatus(); };
    timer = setInterval(tick, delay);
    const onVisible = () => { if (!document.hidden) syncTunnelStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tunnelEnabled, tsEnabled, tunnelReachable, tsReachable]);

  // Browser-side periodic ping: probes tunnel/tailscale URLs directly so UI stays
  // "reachable" even when backend DNS (1.1.1.1) hiccups on *.ts.net or *.trycloudflare.com.
  // Adaptive: slow when healthy, fast when degraded; pause when tab hidden.
  useEffect(() => {
    const probeBoth = async () => {
      if (document.hidden) return;
      if (tunnelEnabled && tunnelUrl && tunnelCanClientPing) {
        const ok = await clientPingUrl(tunnelUrl);
        tunnelClientReachableRef.current = ok;
        if (ok) { tunnelMissRef.current = 0; setTunnelReachable(true); if (!tunnelEverReachableRef.current) { tunnelEverReachableRef.current = true; setTunnelEverReachable(true); } }
      } else {
        tunnelClientReachableRef.current = false;
      }
      if (tsEnabled && tsUrl && tsCanClientPing) {
        const ok = await clientPingUrl(tsUrl);
        tsClientReachableRef.current = ok;
        if (ok) { tsMissRef.current = 0; setTsReachable(true); if (!tsEverReachableRef.current) { tsEverReachableRef.current = true; setTsEverReachable(true); } }
      } else {
        tsClientReachableRef.current = false;
      }
    };
    const anyEnabled = (tunnelEnabled && tunnelUrl && tunnelCanClientPing) || (tsEnabled && tsUrl && tsCanClientPing);
    if (!anyEnabled) return;
    probeBoth();
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    const delay = allHealthy ? CLIENT_PING_SLOW_MS : CLIENT_PING_FAST_MS;
    const id = setInterval(probeBoth, delay);
    return () => clearInterval(id);
  }, [tunnelEnabled, tunnelUrl, tunnelCanClientPing, tsEnabled, tsUrl, tsCanClientPing, tunnelReachable, tsReachable]);

  // Effective reachable = serverReachable OR clientReachable (1 of 2 is enough).
  // Miss-debounce: only flip to false after N consecutive misses on BOTH sides.
  const updateReachable = useCallback((serverReachable, clientRef, missRef, setter, everRef, everSetter) => {
    if (!isMountedRef.current) return;
    const reachable = serverReachable || clientRef.current;
    if (reachable) {
      missRef.current = 0;
      setter(true);
      if (!everRef.current) {
        everRef.current = true;
        everSetter(true);
      }
    } else {
      missRef.current += 1;
      if (missRef.current >= REACHABLE_MISS_THRESHOLD) setter(false);
    }
  }, []);

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process
  const syncTunnelStatus = async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!isMountedRef.current) return;
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      if (!isMountedRef.current) return;
      const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
      const tUrl = data.tunnel?.tunnelUrl || "";
      const tCanClientPing = !!(data.tunnel?.running || data.tunnel?.enabled || data.tunnel?.reachable);
      setTunnelUrl(tUrl);
      setTunnelPublicUrl(data.tunnel?.publicUrl || "");
      setTunnelEnabled(tEnabled);
      setTunnelCanClientPing(tCanClientPing);
      updateReachable(!!data.tunnel?.reachable, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

      const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
      const tsUrlVal = data.tailscale?.tunnelUrl || "";
      const tsCanClientPingValue = !!(data.tailscale?.running || data.tailscale?.enabled || data.tailscale?.reachable);
      setTsUrl(tsUrlVal);
      setTsEnabled(tsEn);
      setTsCanClientPing(tsCanClientPingValue);
      updateReachable(!!data.tailscale?.reachable, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
    } catch { /* ignore poll errors */ }
  };

  const loadSettings = async () => {
    if (isMountedRef.current) setTunnelChecking(true);
    try {
      const [settingsRes, statusRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tunnel/status", { cache: "no-store" })
      ]);
      if (!isMountedRef.current) return;
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setRequireApiKey(data.requireApiKey || false);
        setRequireLogin(data.requireLogin !== false);
        setHasPassword(data.hasPassword || false);
        setTunnelDashboardAccess(data.tunnelDashboardAccess || false);
        setRtkEnabledState(data.rtkEnabled !== false);
        setCavemanEnabled(!!data.cavemanEnabled);
        setCavemanLevel(data.cavemanLevel || "full");
        setToonEnabled(!!data.toonEnabled);
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
        const tUrl = data.tunnel?.tunnelUrl || "";
        const tCanClientPing = !!(data.tunnel?.running || data.tunnel?.enabled || data.tunnel?.reachable);
        setTunnelUrl(tUrl);
        setTunnelPublicUrl(data.tunnel?.publicUrl || "");
        setTunnelEnabled(tEnabled);
        setTunnelCanClientPing(tCanClientPing);
        updateReachable(!!data.tunnel?.reachable, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

        const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
        const tsUrlVal = data.tailscale?.tunnelUrl || "";
        const tsCanClientPingValue = !!(data.tailscale?.running || data.tailscale?.enabled || data.tailscale?.reachable);
        setTsUrl(tsUrlVal);
        setTsEnabled(tsEn);
        setTsCanClientPing(tsCanClientPingValue);
        updateReachable(!!data.tailscale?.reachable, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      if (isMountedRef.current) setTunnelChecking(false);
    }
  };

  const handleTunnelDashboardAccess = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnelDashboardAccess: value }),
      });
      if (res.ok) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handleToonEnabled = (value) => {
    setToonEnabled(value);
    patchSetting({ toonEnabled: value });
  };

  const handleCavemanMode = (mode) => {
    const current = getCavemanSelection(cavemanLevel);
    handleCavemanLevel(toCavemanLevel({ ...current, mode }));
  };

  const handleCavemanIntensity = (intensity) => {
    const current = getCavemanSelection(cavemanLevel);
    handleCavemanLevel(toCavemanLevel({ ...current, intensity }));
  };

  const fetchData = async () => {
    try {
      const keysRes = await fetch("/api/keys");
      const keysData = await keysRes.json();
      if (keysRes.ok && isMountedRef.current) {
        setKeys(keysData.keys || []);
      }
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  };

  // ─── Cloudflare Tunnel handlers
  // Ping tunnel health until reachable, also check backend status to detect process die
  const pingTunnelHealth = async (url) => {
    if (isMountedRef.current) {
      setTunnelLoading(true);
      setTunnelProgress("Waiting for tunnel ready...");
    }
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      if (!isMountedRef.current) return false;
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (!isMountedRef.current) return false;
        if (ping.ok || ping.type === "opaque") {
          setTunnelEnabled(true);
          setTunnelCanClientPing(true);
          setTunnelLoading(false);
          setTunnelProgress("");
          return true;
        }
      } catch { /* not ready yet */ }
      // Every 5 pings (~10s), check if backend process still alive
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status");
          if (!isMountedRef.current) return false;
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!isMountedRef.current) return false;
            if (!status.tunnel?.enabled) {
              setTunnelStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setTunnelLoading(false);
              setTunnelProgress("");
              return false;
            }
          }
        } catch { /* ignore */ }
      }
    }
    if (isMountedRef.current) {
      setTunnelStatus({ type: "error", message: "Tunnel created but not reachable. Please try again." });
      setTunnelLoading(false);
      setTunnelProgress("");
    }
    return false;
  };

  const handleEnableTunnel = async () => {
    setShowEnableTunnelModal(false);
    setTunnelLoading(true);
    setTunnelStatus(null);
    setTunnelProgress("Creating tunnel...");

    // Poll download progress while enable request is pending
    let polling = true;
    const pollProgress = async () => {
      while (polling) {
        try {
          const r = await fetch("/api/tunnel/status");
          if (!isMountedRef.current) return;
          if (r.ok) {
            const s = await r.json();
            if (!isMountedRef.current) return;
            if (s.download?.downloading) {
              setTunnelProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setTunnelProgress("Creating tunnel...");
            }
          }
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      if (!isMountedRef.current) return;
      const data = await res.json();
      if (!isMountedRef.current) return;
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to enable tunnel" });
        return;
      }

      const url = data.tunnelUrl;
      if (!url) {
        setTunnelStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }

      setTunnelUrl(url);
      setTunnelPublicUrl(data.publicUrl || "");
      await pingTunnelHealth(url);
    } catch (error) {
      if (isMountedRef.current) setTunnelStatus({ type: "error", message: error.message });
    } finally {
      polling = false;
      if (isMountedRef.current) {
        setTunnelLoading(false);
        setTunnelProgress("");
      }
    }
  };

  const handleDisableTunnel = async () => {
    setTunnelLoading(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      if (!isMountedRef.current) return;
      const data = await res.json();
      if (!isMountedRef.current) return;
      if (res.ok) {
        setTunnelEnabled(false);
        setTunnelCanClientPing(false);
        setTunnelUrl("");
        setShowDisableTunnelModal(false);
        setTunnelStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setTunnelStatus({ type: "error", message: data.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      if (isMountedRef.current) setTunnelStatus({ type: "error", message: error.message });
    } finally {
      if (isMountedRef.current) {
        setTunnelLoading(false);
      }
    }
  };

  // ─── Tailscale handlers
  const checkTailscaleInstalled = async () => {
    if (isMountedRef.current) setTsInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (!isMountedRef.current) return { installed: false };
      if (res.ok) {
        const data = await res.json();
        if (!isMountedRef.current) return { installed: false };
        setTsInstalled(data.installed);
        return data;
      }
    } catch { /* ignore */ }
    if (isMountedRef.current) setTsInstalled(false);
    return { installed: false };
  };

  const handleInstallTailscale = async () => {
    if (isMountedRef.current) {
      setTsInstalling(true);
      setTsStatus(null);
      setTsInstallLog([]);
    }
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: tsSudoPassword }),
      });
      if (!isMountedRef.current) return;
      setTsSudoPassword("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (!isMountedRef.current) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          let event = "progress";
          let data = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            if (line.startsWith("data: ")) {
              try { data = JSON.parse(line.slice(6)); } catch { /* skip */ }
            }
          }
          if (!data) continue;
          if (!isMountedRef.current) return;
          if (event === "progress") {
            setTsInstallLog((prev) => [...prev.slice(-50), data.message]);
          } else if (event === "done") {
            setTsInstalled(true);
            setTsInstalling(false);
            setShowTsModal(false);
            handleConnectTailscale();
            return;
          } else if (event === "error") {
            setTsStatus({ type: "error", message: data.error || "Install failed" });
          }
        }
      }
    } catch (e) {
      if (isMountedRef.current) setTsStatus({ type: "error", message: e.message });
    } finally {
      if (isMountedRef.current) setTsInstalling(false);
    }
  };

  // Ping Tailscale health until reachable
  const pingTsHealth = async (url) => {
    if (isMountedRef.current) setTsProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      if (!isMountedRef.current) return false;
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (!isMountedRef.current) return false;
        if (ping.ok || ping.type === "opaque") return true;
      } catch { /* not ready yet */ }
    }
    return false;
  };

  // Show inline login button instead of auto-opening popup (browsers block popups
  // opened after async work because the user gesture is lost).
  const requestUserAuth = (url, label) => {
    setTsAuthUrl(url);
    setTsAuthLabel(label);
  };

  const clearUserAuth = () => {
    setTsAuthUrl("");
    setTsAuthLabel("");
  };

  const handleConnectTailscale = async () => {
    if (isMountedRef.current) {
      setShowTsModal(false);
      setTsConnecting(true);
      setTsLoading(true);
      setTsStatus(null);
      setTsProgress("Connecting...");
      clearUserAuth();
    }
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      if (!isMountedRef.current) return;
      const data = await res.json();
      if (!isMountedRef.current) return;

      if (res.ok && data.success) {
        setTsUrl(data.tunnelUrl || "");
        setTsCanClientPing(true);
        const reachable = await pingTsHealth(data.tunnelUrl);
        if (!isMountedRef.current) return;
        setTsEnabled(true);
        setTsStatus(reachable ? null : { type: "warning", message: "Connected but not reachable yet." });
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setTsProgress("Login required — click \"Open Login Page\" to continue");
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          if (!isMountedRef.current) return;
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (!isMountedRef.current) return;
            if (r2.ok) {
              const check = await r2.json();
              if (!isMountedRef.current) return;
              if (check.loggedIn) {
                clearUserAuth();
                setTsProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                if (!isMountedRef.current) return;
                const data2 = await res2.json();
                if (!isMountedRef.current) return;
                if (res2.ok && data2.success) {
                  setTsUrl(data2.tunnelUrl || "");
                  setTsCanClientPing(true);
                  const ok2 = await pingTsHealth(data2.tunnelUrl);
                  if (!isMountedRef.current) return;
                  setTsEnabled(true);
                  setTsStatus(ok2 ? null : { type: "warning", message: "Connected but not reachable yet." });
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setTsStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch { /* retry */ }
        }
        if (isMountedRef.current) {
          clearUserAuth();
          setTsStatus({ type: "error", message: "Login timed out. Please try again." });
        }
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setTsStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      if (isMountedRef.current) setTsStatus({ type: "error", message: error.message });
    } finally {
      if (isMountedRef.current) {
        setTsLoading(false);
        setTsConnecting(false);
        setTsProgress("");
        clearUserAuth();
      }
    }
  };

  const pollFunnelEnable = async (enableUrl) => {
    if (isMountedRef.current) {
      requestUserAuth(enableUrl, "Open Funnel Settings");
      setTsProgress("Click \"Open Funnel Settings\" to enable Funnel...");
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!isMountedRef.current) return;
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        if (!isMountedRef.current) return;
        const data = await res.json();
        if (!isMountedRef.current) return;
        if (res.ok && data.success) {
          clearUserAuth();
          setTsUrl(data.tunnelUrl || "");
          setTsCanClientPing(true);
          const ok3 = await pingTsHealth(data.tunnelUrl);
          if (!isMountedRef.current) return;
          setTsEnabled(true);
          setTsStatus(ok3 ? null : { type: "warning", message: "Connected but not reachable yet." });
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setTsStatus({ type: "error", message: data.error });
          return;
        }
      } catch { /* retry */ }
    }
    if (isMountedRef.current) {
      clearUserAuth();
      setTsStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
    }
  };

  const handleDisableTailscale = async () => {
    setTsLoading(true);
    setTsStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      if (!isMountedRef.current) return;
      const data = await res.json();
      if (!isMountedRef.current) return;
      if (res.ok) {
        setTsEnabled(false);
        setTsCanClientPing(false);
        setTsUrl("");
        setShowDisableTsModal(false);
        setTsStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setTsStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      if (isMountedRef.current) setTsStatus({ type: "error", message: e.message });
    } finally {
      if (isMountedRef.current) {
        setTsLoading(false);
      }
    }
  };

  const handleOpenTsModal = async () => {
    setTsStatus(null);
    setTsInstallLog([]);
    const data = await checkTailscaleInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      handleConnectTailscale();
    } else {
      setShowTsModal(true);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName,
          limitMode: newKeyLimitMode,
          tokenLimit: newKeyLimitMode === "unlimited" || newKeyLimitMode === DUAL_LIMIT_MODE ? null : Number(newKeyTokenLimit),
          dailyTokenLimit: newKeyLimitMode === DUAL_LIMIT_MODE ? Number(newKeyDailyTokenLimit) : null,
          weeklyTokenLimit: newKeyLimitMode === DUAL_LIMIT_MODE ? Number(newKeyWeeklyTokenLimit) : null,
          expiresInMs: newKeyExpiresInHours ? Number(newKeyExpiresInHours) * 60 * 60 * 1000 : null,
        }),
      });
      if (!isMountedRef.current) return;
      const data = await res.json();
      if (!isMountedRef.current) return;

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        if (!isMountedRef.current) return;
        setNewKeyName("");
        setNewKeyLimitMode("unlimited");
        setNewKeyTokenLimit("");
        setNewKeyDailyTokenLimit("");
        setNewKeyWeeklyTokenLimit("");
        setNewKeyExpiresInHours("");
        setShowAddModal(false);
      }
    } catch (error) {
      console.log("Error creating key:", error);
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        if (isMountedRef.current) setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (!isMountedRef.current) return;
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      }
    });
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!isMountedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        if (!isMountedRef.current) return;
        setKeys(prev => prev.map(k => k.id === id ? (data.key || { ...k, isActive }) : k));
      }
    } catch (error) {
      console.log("Error toggling key:", error);
    }
  };

  const getKeyEdit = (key) => ({
    limitMode: key.limitMode || "unlimited",
    tokenLimit: key.tokenLimit || "",
    dailyTokenLimit: key.dailyTokenLimit || "",
    weeklyTokenLimit: key.weeklyTokenLimit || "",
    expiresAt: toDateTimeLocal(key.expiresAt),
    autoDeleteExpired: key.autoDeleteExpired !== false,
    ...(keyEdits[key.id] || {}),
  });

  const updateKeyEdit = (keyId, patch) => {
    setKeyEdits((prev) => ({
      ...prev,
      [keyId]: { ...(prev[keyId] || {}), ...patch },
    }));
  };

  const saveKeyConfig = async (key) => {
    const edit = getKeyEdit(key);
    setSavingKeyId(key.id);
    try {
      const body = {
        limitMode: edit.limitMode || "unlimited",
        tokenLimit: edit.limitMode === "unlimited" || edit.limitMode === DUAL_LIMIT_MODE ? null : Number(edit.tokenLimit),
        dailyTokenLimit: edit.limitMode === DUAL_LIMIT_MODE ? Number(edit.dailyTokenLimit) : null,
        weeklyTokenLimit: edit.limitMode === DUAL_LIMIT_MODE ? Number(edit.weeklyTokenLimit) : null,
        expiresAt: fromDateTimeLocal(edit.expiresAt),
        autoDeleteExpired: edit.autoDeleteExpired !== false,
      };
      const res = await fetch(`/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!isMountedRef.current) return;
      const data = await res.json();
      if (!isMountedRef.current) return;
      if (res.ok) {
        setKeys((prev) => prev.map((k) => k.id === key.id ? data.key : k));
        setKeyEdits((prev) => {
          const next = { ...prev };
          delete next[key.id];
          return next;
        });
        setSettingsKeyId(null);
      }
    } catch (error) {
      console.log("Error saving key config:", error);
    } finally {
      if (isMountedRef.current) setSavingKeyId(null);
    }
  };

  const resetKeyUsage = async (key, period) => {
    const label = period === "all" ? "all-time" : period;
    setConfirmState({
      title: "Reset Token Usage",
      message: `Reset ${label} token usage for "${key.name}"?`,
      onConfirm: async () => {
        if (isMountedRef.current) setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${key.id}/usage?period=${period}`, { method: "DELETE" });
          if (!isMountedRef.current) return;
          if (res.ok) {
            const data = await res.json();
            if (!isMountedRef.current) return;
            setKeys((prev) => prev.map((k) => (k.id === key.id ? data.key : k)));
          }
        } catch (error) {
          console.log("Error resetting key usage:", error);
        }
      },
    });
  };

  const maskKey = (fullKey) => {
    if (!fullKey) return "";
    return fullKey.length > 8 ? fullKey.slice(0, 8) + "..." : fullKey;
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const [baseUrl, setBaseUrl] = useState("/v1");

  // Hydration fix: Only access window on client side
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;
  const settingsKey = settingsKeyId ? keys.find((key) => key.id === settingsKeyId) : null;
  const limitedKeys = keys.filter((key) => key.limitMode !== "unlimited");
  const previewKeys = keys.slice(0, 5);
  const hiddenPreviewKeyCount = Math.max(0, keys.length - previewKeys.length);
  const needsCreateTokenLimit = newKeyLimitMode !== "unlimited" && newKeyLimitMode !== DUAL_LIMIT_MODE && !newKeyTokenLimit;
  const needsCreateDualLimits = newKeyLimitMode === DUAL_LIMIT_MODE && (!newKeyDailyTokenLimit || !newKeyWeeklyTokenLimit);
  const cavemanSelection = getCavemanSelection(cavemanLevel);
  const cavemanIntensityIndex = Math.max(0, CAVEMAN_INTENSITIES.findIndex((item) => item.id === cavemanSelection.intensity));

  return (
    <div className="flex flex-col gap-8">
      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">api</span>
          API Endpoint
        </h2>

        {/* Endpoint rows */}
        <div className="flex flex-col gap-2">
          {/* Local */}
          <EndpointRow
            label="Local"
            url={currentEndpoint}
            copyId="local_url"
            copied={copied}
            onCopy={copy}
          />
          {/* Cloudflare Tunnel */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
              tunnelEnabled ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
            }`}>Tunnel</span>
            {tunnelEnabled && !tunnelLoading && tunnelReachable ? (
              <>
                <Input value={`${tunnelPublicUrl || tunnelUrl}/v1`} readOnly className="flex-1 font-mono text-sm" />
                <button
                  onClick={() => copy(`${tunnelPublicUrl || tunnelUrl}/v1`, "tunnel_url")}
                  className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">{copied === "tunnel_url" ? "check" : "content_copy"}</span>
                </button>
                <button
                  onClick={() => setShowDisableTunnelModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tunnel"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelEnabled && !tunnelLoading && !tunnelReachable ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-500/5 text-sm text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tunnelEverReachable ? "Tunnel reconnecting..." : "Tunnel checking..."}
                </div>
                <button
                  onClick={() => setShowDisableTunnelModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tunnel"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelLoading ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tunnelProgress || "Creating tunnel..."}
                </div>
                <button
                  onClick={() => { setTunnelLoading(false); setTunnelProgress(""); }}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelStatus?.type === "error" ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-red-300 dark:border-red-800 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
                  <span className="material-symbols-outlined text-sm">error</span>
                  {tunnelStatus.message}
                </div>
                <Button size="sm" icon="cloud_upload" onClick={() => setShowEnableTunnelModal(true)}>Enable</Button>
              </>
            ) : tunnelChecking ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Checking...
                </div>
                <button
                  onClick={() => setTunnelChecking(false)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : (
              <Button
                size="sm"
                icon="cloud_upload"
                onClick={() => {
                  if (!requireApiKey) {
                    setTunnelStatus({ type: "error", message: "Security required: Enable \"Require API key\" before activating the tunnel." });
                    return;
                  }
                  setShowEnableTunnelModal(true);
                }}
              >
                Enable
              </Button>
            )}
          </div>
          {/* Tailscale */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
              tsEnabled ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
            }`}>Tailscale</span>
            {tsEnabled && !tsLoading && tsReachable ? (
              <>
                <Input value={`${tsUrl}/v1`} readOnly className="flex-1 font-mono text-sm" />
                <button
                  onClick={() => copy(`${tsUrl}/v1`, "ts_url")}
                  className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">{copied === "ts_url" ? "check" : "content_copy"}</span>
                </button>
                <button
                  onClick={() => setShowDisableTsModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tailscale"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tsEnabled && !tsLoading && !tsReachable ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-500/5 text-sm text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tsEverReachable ? "Tailscale reconnecting..." : "Tailscale checking..."}
                </div>
                <button
                  onClick={() => setShowDisableTsModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tailscale"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : (tsLoading || tsConnecting) ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tsProgress || "Connecting..."}
                </div>
                {tsAuthUrl && (
                  <Button
                    size="sm"
                    icon="open_in_new"
                    onClick={() => window.open(tsAuthUrl, "tailscale_auth", "width=600,height=700,noopener,noreferrer")}
                  >
                    {tsAuthLabel || "Open"}
                  </Button>
                )}
                <button
                  onClick={() => { setTsLoading(false); setTsConnecting(false); setTsProgress(""); clearUserAuth(); }}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tsStatus?.type === "error" ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-red-300 dark:border-red-800 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
                  <span className="material-symbols-outlined text-sm">error</span>
                  {tsStatus.message}
                </div>
                <Button size="sm" icon="vpn_lock" onClick={handleOpenTsModal}>Enable</Button>
              </>
            ) : (
              <Button
                size="sm"
                icon="vpn_lock"
                onClick={handleOpenTsModal}
                className="bg-linear-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white!"
              >
                Enable
              </Button>
            )}
          </div>
        </div>

        {/* Security warnings when tunnel or tailscale is active */}
        {(tunnelEnabled || tsEnabled) && (
          <div className="mt-4 flex flex-col gap-2">
            {!requireApiKey && (
              <SecurityWarning
                message="Require API key is disabled — your endpoint is publicly accessible without authentication."
                action={{ label: "Enable", href: "#require-api-key" }}
              />
            )}
            {(!requireLogin || !hasPassword) && (
              <SecurityWarning
                message={
                  !requireLogin
                    ? "Require login is disabled — anyone can access your dashboard via tunnel."
                    : "Dashboard uses the default password — change it in Profile settings."
                }
                action={{
                  label: !requireLogin ? "Enable" : "Change password",
                  href: "/dashboard/profile",
                }}
              />
            )}
          </div>
        )}

        {/* Tunnel dashboard access option */}
        {(tunnelEnabled || tsEnabled) && (
          <div className="mt-4 pt-4 border-t border-border flex items-center gap-3">
            <Toggle
              checked={tunnelDashboardAccess}
              onChange={() => handleTunnelDashboardAccess(!tunnelDashboardAccess)}
            />
            <div className="flex items-center gap-1.5">
              <p className="font-medium text-sm">Allow dashboard access via tunnel</p>
              <Tooltip text="When enabled, the dashboard can be accessed through your tunnel or Tailscale URL (login still required). When disabled, dashboard access via tunnel/Tailscale is completely blocked." />
            </div>
          </div>
        )}
      </Card>

      {/* Token Saver (RTK + Caveman) */}
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">bolt</span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              git/grep/ls/tree/logs → 60-90% fewer input tokens
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>
        <div className="flex items-center justify-between pt-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Terse-style system prompt → ~65% fewer output tokens (up to 87%)
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex items-center justify-end gap-3 flex-wrap">
                <div className="flex items-center gap-1 rounded-[10px] border border-border bg-bg p-1">
                  {CAVEMAN_MODES.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => handleCavemanMode(mode.id)}
                      className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        cavemanSelection.mode === mode.id
                          ? "bg-primary text-white"
                          : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                      }`}
                      title={mode.desc}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                <div className="min-w-[190px] rounded-[10px] border border-border bg-bg px-3 py-2">
                  <input
                    type="range"
                    min="0"
                    max={CAVEMAN_INTENSITIES.length - 1}
                    step="1"
                    value={cavemanIntensityIndex}
                    onChange={(event) => {
                      const next = CAVEMAN_INTENSITIES[Number(event.target.value)] || CAVEMAN_INTENSITIES[1];
                      handleCavemanIntensity(next.id);
                    }}
                    className="block w-full accent-primary"
                    aria-label="Caveman intensity"
                  />
                  <div className="mt-1 grid grid-cols-3 gap-1 text-center text-[11px] font-medium text-text-muted">
                    {CAVEMAN_INTENSITIES.map((item) => (
                      <span
                        key={item.id}
                        className={cavemanSelection.intensity === item.id ? "text-primary" : ""}
                        title={item.desc}
                      >
                        {item.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 pb-2 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress JSON tool output{" "}
              <a
                href="https://toonformat.dev"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (TOON)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              JSON tool_results → compact tabular notation (~20-50% fewer tokens)
            </p>
          </div>
          <Toggle
            checked={toonEnabled}
            onChange={() => handleToonEnabled(!toonEnabled)}
          />
        </div>
      </Card>

      {/* API Keys */}
      <Card id="require-api-key">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            API Keys
          </h2>
          <button
            type="button"
            onClick={() => setShowKeyManager(true)}
            className="flex size-9 items-center justify-center rounded-[10px] border border-border text-text-muted hover:bg-surface-2 hover:text-primary transition-colors"
            title="Open API key manager"
          >
            <span className="material-symbols-outlined text-[20px]">settings</span>
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 mb-4">
          <UsageStatBox label="Keys" value={keys.length} hint={`${keys.filter((key) => key.isActive !== false).length} active`} />
          <UsageStatBox label="Limited" value={limitedKeys.length} hint="daily / weekly / dual / hard" />
          <UsageStatBox
            label="Token usage"
            value={formatTokens(keys.reduce((sum, key) => sum + (key.usage?.periods?.allTime?.used || key.usage?.totalUsed || 0), 0))}
            hint="all API keys"
          />
        </div>

        {previewKeys.length > 0 && (
          <div className="mb-4 rounded-[10px] border border-border-subtle bg-bg p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-text-main">API key quota usage</p>
                <p className="text-xs text-text-muted">
                  {hiddenPreviewKeyCount > 0 ? `Showing 5 keys, 4 visible. ${hiddenPreviewKeyCount} more in manager.` : "API keys with quota bars"}
                </p>
              </div>
              {hiddenPreviewKeyCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowKeyManager(true)}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Manage all
                </button>
              )}
            </div>
            <div className="grid max-h-[316px] gap-2 overflow-y-auto pr-1">
              {previewKeys.map((key) => (
                <ApiKeyUsageBar key={key.id} apiKey={key} />
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between rounded-[10px] border border-border-subtle bg-bg px-4 py-3">
          <div>
            <p className="font-medium">Require API key</p>
            <p className="text-sm text-text-muted">Requests without a valid key will be rejected</p>
          </div>
          <Toggle checked={requireApiKey} onChange={() => handleRequireApiKey(!requireApiKey)} />
        </div>
      </Card>

      <Modal
        isOpen={showKeyManager}
        title="API Key Manager"
        size="full"
        onClose={() => {
          setShowKeyManager(false);
          setSettingsKeyId(null);
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-main">{keys.length} keys</p>
              <p className="text-xs text-text-muted">Use the cog on each key to edit limits, expiry, or reset usage.</p>
            </div>
            <Button icon="add" onClick={() => setShowAddModal(true)}>Create Key</Button>
          </div>

          {keys.length === 0 ? (
            <div className="text-center py-12 rounded-[10px] border border-border-subtle bg-bg">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 text-primary mb-4">
                <span className="material-symbols-outlined text-[30px]">vpn_key</span>
              </div>
              <p className="text-text-main font-medium mb-1">No API keys yet</p>
              <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
              <Button icon="add" onClick={() => setShowAddModal(true)}>Create Key</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {keys.map((key) => {
                const usage = key.usage || {};
                const status = keyStatusMeta(key.status || (key.isActive === false ? "paused" : "active"));
                const daily = getUsagePeriod(usage, "daily");
                const weekly = getUsagePeriod(usage, "weekly");
                const allTime = getUsagePeriod(usage, "allTime");

                return (
                  <div
                    key={key.id}
                    className={`group rounded-[10px] border border-border-subtle bg-bg p-3 ${key.isActive === false ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{key.name}</p>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>{status.label}</span>
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-surface-2 text-text-muted">
                            {key.limitMode || "unlimited"}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 min-w-0">
                          <code className="text-xs text-text-muted font-mono truncate">
                            {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                          </code>
                          <button
                            onClick={() => toggleKeyVisibility(key.id)}
                            className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors"
                            title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                            </span>
                          </button>
                          <button
                            onClick={() => copy(key.key, key.id)}
                            className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors"
                            title="Copy key"
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              {copied === key.id ? "check" : "content_copy"}
                            </span>
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Toggle
                          size="sm"
                          checked={key.isActive ?? true}
                          onChange={(checked) => {
                            if (key.isActive && !checked) {
                              setConfirmState({
                                title: "Pause API Key",
                                message: `Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
                                onConfirm: async () => {
                                  setConfirmState(null);
                                  handleToggleKey(key.id, checked);
                                },
                              });
                            } else {
                              handleToggleKey(key.id, checked);
                            }
                          }}
                          title={key.isActive ? "Pause key" : "Resume key"}
                        />
                        <button
                          onClick={() => setSettingsKeyId(key.id)}
                          className="p-2 rounded-[10px] border border-border text-text-muted hover:bg-surface-2 hover:text-primary transition-colors"
                          title="Key settings"
                        >
                          <span className="material-symbols-outlined text-[18px]">settings</span>
                        </button>
                        <button
                          onClick={() => handleDeleteKey(key.id)}
                          className="p-2 rounded-[10px] text-red-500 hover:bg-red-500/10 transition-colors"
                          title="Delete key"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <UsageStatBox label="All time" value={formatTokens(allTime.used || usage.totalUsed)} hint={`${allTime.requests || usage.totalRequests || 0} req`} />
                      <UsageStatBox label="Daily" value={formatTokens(daily.used)} hint={formatKeyReset(daily.resetAt)} tone={key.limitMode === "daily" || key.limitMode === DUAL_LIMIT_MODE ? "warning" : "default"} />
                      <UsageStatBox label="Weekly" value={formatTokens(weekly.used)} hint={formatKeyReset(weekly.resetAt)} tone={key.limitMode === "weekly" || key.limitMode === DUAL_LIMIT_MODE ? "warning" : "default"} />
                    </div>

                    <div className="mt-3 space-y-2">
                      <ApiKeyUsageBar apiKey={key} />
                      <p className="text-[11px] text-text-muted">
                        Expires {formatCompactDateTime(key.expiresAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={!!settingsKey}
        title={settingsKey ? `Key Settings: ${settingsKey.name}` : "Key Settings"}
        onClose={() => setSettingsKeyId(null)}
      >
        {settingsKey && (() => {
          const edit = getKeyEdit(settingsKey);
          const isDual = edit.limitMode === DUAL_LIMIT_MODE;
          const saveDisabled = savingKeyId === settingsKey.id
            || (isDual && (!edit.dailyTokenLimit || !edit.weeklyTokenLimit))
            || (!["unlimited", DUAL_LIMIT_MODE].includes(edit.limitMode) && !edit.tokenLimit);
          return (
            <div className="flex flex-col gap-4">
              <label className="text-sm text-text-muted">
                <span className="block mb-1 font-medium text-text-primary">Mode</span>
                <select
                  value={edit.limitMode}
                  onChange={(e) => updateKeyEdit(settingsKey.id, { limitMode: e.target.value })}
                  className="h-10 w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-text-primary"
                >
                  {API_KEY_LIMIT_MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>{mode.label}</option>
                  ))}
                </select>
              </label>
              <Input
                label="Token limit"
                type="number"
                min="1"
                value={edit.tokenLimit}
                disabled={edit.limitMode === "unlimited" || isDual}
                onChange={(e) => updateKeyEdit(settingsKey.id, { tokenLimit: e.target.value })}
              />
              {isDual && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Daily token limit"
                    type="number"
                    min="1"
                    value={edit.dailyTokenLimit}
                    onChange={(e) => updateKeyEdit(settingsKey.id, { dailyTokenLimit: e.target.value })}
                  />
                  <Input
                    label="Weekly token limit"
                    type="number"
                    min="1"
                    value={edit.weeklyTokenLimit}
                    onChange={(e) => updateKeyEdit(settingsKey.id, { weeklyTokenLimit: e.target.value })}
                  />
                </div>
              )}
              <Input
                label="Expires"
                type="datetime-local"
                value={edit.expiresAt}
                onChange={(e) => updateKeyEdit(settingsKey.id, { expiresAt: e.target.value })}
              />
              <div className="flex items-center justify-between rounded-[10px] border border-border-subtle bg-bg px-3 py-2">
                <span className="text-sm font-medium text-text-main">Auto-delete expired</span>
                <Toggle
                  size="sm"
                  checked={edit.autoDeleteExpired !== false}
                  onChange={(checked) => updateKeyEdit(settingsKey.id, { autoDeleteExpired: checked })}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm" onClick={() => resetKeyUsage(settingsKey, "daily")}>Reset Daily</Button>
                <Button variant="outline" size="sm" onClick={() => resetKeyUsage(settingsKey, "weekly")}>Reset Weekly</Button>
                <Button variant="danger" size="sm" onClick={() => resetKeyUsage(settingsKey, "all")}>Reset All</Button>
              </div>
              <Button
                onClick={() => saveKeyConfig(settingsKey)}
                disabled={saveDisabled}
              >
                {savingKeyId === settingsKey.id ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          );
        })()}
      </Modal>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
          setNewKeyLimitMode("unlimited");
          setNewKeyTokenLimit("");
          setNewKeyDailyTokenLimit("");
          setNewKeyWeeklyTokenLimit("");
          setNewKeyExpiresInHours("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-text-muted">
              <span className="block mb-1 font-medium text-text-primary">Token mode</span>
              <select
                value={newKeyLimitMode}
                onChange={(e) => setNewKeyLimitMode(e.target.value)}
                className="h-10 w-full rounded border border-border bg-surface px-3 text-sm text-text-primary"
              >
                {API_KEY_LIMIT_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-muted">
              <span className="block mb-1 font-medium text-text-primary">Token limit</span>
              <input
                type="number"
                min="1"
                value={newKeyTokenLimit}
                disabled={newKeyLimitMode === "unlimited" || newKeyLimitMode === DUAL_LIMIT_MODE}
                onChange={(e) => setNewKeyTokenLimit(e.target.value)}
                placeholder="100000"
                className="h-10 w-full rounded border border-border bg-surface px-3 text-sm text-text-primary disabled:opacity-50"
              />
            </label>
          </div>
          {newKeyLimitMode === DUAL_LIMIT_MODE && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm text-text-muted">
                <span className="block mb-1 font-medium text-text-primary">Daily token limit</span>
                <input
                  type="number"
                  min="1"
                  value={newKeyDailyTokenLimit}
                  onChange={(e) => setNewKeyDailyTokenLimit(e.target.value)}
                  placeholder="5000000"
                  className="h-10 w-full rounded border border-border bg-surface px-3 text-sm text-text-primary"
                />
              </label>
              <label className="text-sm text-text-muted">
                <span className="block mb-1 font-medium text-text-primary">Weekly token limit</span>
                <input
                  type="number"
                  min="1"
                  value={newKeyWeeklyTokenLimit}
                  onChange={(e) => setNewKeyWeeklyTokenLimit(e.target.value)}
                  placeholder="20000000"
                  className="h-10 w-full rounded border border-border bg-surface px-3 text-sm text-text-primary"
                />
              </label>
            </div>
          )}
          <label className="text-sm text-text-muted">
            <span className="block mb-1 font-medium text-text-primary">Expire after hours</span>
            <input
              type="number"
              min="1"
              value={newKeyExpiresInHours}
              onChange={(e) => setNewKeyExpiresInHours(e.target.value)}
              placeholder="Blank = permanent"
              className="h-10 w-full rounded border border-border bg-surface px-3 text-sm text-text-primary"
            />
          </label>
          <div className="flex gap-2">
            <Button
              onClick={handleCreateKey}
              fullWidth
              disabled={!newKeyName.trim() || needsCreateTokenLimit || needsCreateDualLimits}
            >
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
                setNewKeyLimitMode("unlimited");
                setNewKeyTokenLimit("");
                setNewKeyDailyTokenLimit("");
                setNewKeyWeeklyTokenLimit("");
                setNewKeyExpiresInHours("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see this key. Store it securely.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Enable Tunnel Modal */}
      <Modal
        isOpen={showEnableTunnelModal}
        title="Enable Tunnel"
        onClose={() => setShowEnableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-surface-2 border border-border-subtle rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-primary">cloud_upload</span>
              <div>
                <p className="text-sm text-text-main font-medium mb-1">
                  Cloudflare Tunnel
                </p>
                <p className="text-sm text-text-muted">
                  Expose your local 9Router to the internet. No port forwarding, no static IP needed. Share endpoint URL with your team or use it in Cursor, Cline, and other AI tools from anywhere.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {TUNNEL_BENEFITS.map((benefit) => (
              <div key={benefit.title} className="flex flex-col items-center text-center p-3 rounded-lg bg-sidebar/50">
                <span className="material-symbols-outlined text-xl text-primary mb-1">{benefit.icon}</span>
                <p className="text-xs font-semibold">{benefit.title}</p>
                <p className="text-xs text-text-muted">{benefit.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted">
            Requires outbound port 7844 (TCP/UDP). Connection may take 10-30s.
          </p>

          <div className="flex gap-2">
            <Button onClick={handleEnableTunnel} fullWidth>
              Start Tunnel
            </Button>
            <Button onClick={() => setShowEnableTunnelModal(false)} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloudflare Tunnel Modal */}
      <Modal
        isOpen={showDisableTunnelModal}
        title="Disable Tunnel"
        onClose={() => !tunnelLoading && setShowDisableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">The Cloudflare tunnel will be disconnected. Remote access via tunnel URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTunnel} fullWidth disabled={tunnelLoading} variant="danger">
              {tunnelLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTunnelModal(false)} variant="ghost" fullWidth disabled={tunnelLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Tailscale Modal */}
      <Modal
        isOpen={showTsModal}
        title="Tailscale Funnel"
        onClose={() => { if (!tsInstalling) { setShowTsModal(false); setTsSudoPassword(""); setTsStatus(null); } }}
      >
        <div className="flex flex-col gap-4">
          {/* Checking state */}
          {tsInstalled === null && (
            <p className="text-sm text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Checking...
            </p>
          )}

          {/* Not installed */}
          {tsInstalled === false && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Tailscale is not installed. Install it to enable Funnel.</p>
              <div className="flex gap-2">
                <Button onClick={handleInstallTailscale} fullWidth>
                  Install Tailscale
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {/* Installing with progress log */}
          {tsInstalling && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Installing Tailscale...
              </div>
              {tsInstallLog.length > 0 && (
                <div ref={tsLogRef} className="bg-black/5 dark:bg-white/5 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-text-muted">
                  {tsInstallLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Installed: show Connect button */}
          {tsInstalled === true && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Tailscale installed
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleConnectTailscale()}
                  fullWidth
                >
                  Connect
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {tsStatus && <StatusAlert status={tsStatus} />}
        </div>
      </Modal>

      {/* Disable Tailscale Modal */}
      <Modal
        isOpen={showDisableTsModal}
        title="Disable Tailscale"
        onClose={() => !tsLoading && setShowDisableTsModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">Tailscale Funnel will be stopped. Remote access via Tailscale URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTailscale} fullWidth disabled={tsLoading} variant="danger">
              {tsLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTsModal(false)} variant="ghost" fullWidth disabled={tsLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}

/** Reusable endpoint row component */
function EndpointRow({ label, url, copyId, copied, onCopy, badge, actions }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
          (badge === "CF" || badge === "TS") ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
        }`}>{label}</span>
      <Input value={url} readOnly className="flex-1 font-mono text-sm" />
      <button
        onClick={() => onCopy(url, copyId)}
        className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
      >
        <span className="material-symbols-outlined text-[18px]">{copied === copyId ? "check" : "content_copy"}</span>
      </button>
      {actions}
    </div>
  );
}

/** Reusable status alert */
function StatusAlert({ status, className = "" }) {
  // Render URLs in message as clickable links
  const renderMessage = (msg) => {
    const parts = msg.split(/(https?:\/\/[^\s]+)/g);
    return parts.map((part, i) =>
      /^https?:\/\//.test(part)
        ? <a key={i} href={part} target="_blank" rel="noreferrer" className="underline font-medium">{part}</a>
        : part
    );
  };

  return (
    <div className={`p-2 rounded text-sm ${className} ${status.type === "success" ? "bg-green-500/10 text-green-600 dark:text-green-400" :
        status.type === "warning" ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" :
        status.type === "info" ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" :
          "bg-red-500/10 text-red-600 dark:text-red-400"
      }`}>
      {renderMessage(status.message)}
    </div>
  );
}

/** Inline tooltip, Claude Code CLI style */
function Tooltip({ text }) {
  return (
    <span className="relative group inline-flex items-center">
      <span className="material-symbols-outlined text-[14px] text-text-muted cursor-help">help</span>
      <span className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 z-50 w-64 rounded bg-gray-900 dark:bg-gray-800 text-white text-xs px-2.5 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
        {text}
      </span>
    </span>
  );
}

/** Security warning banner with optional action link */
function SecurityWarning({ message, action }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
      <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">warning</span>
      <p className="text-xs flex-1">{message}</p>
      {action && (
        <a
          href={action.href}
          className="text-xs font-medium underline shrink-0 hover:opacity-80"
          onClick={action.href.startsWith("#") ? (e) => {
            e.preventDefault();
            document.getElementById(action.href.slice(1))?.scrollIntoView({ behavior: "smooth" });
          } : undefined}
        >
          {action.label}
        </a>
      )}
    </div>
  );
}

APIPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
