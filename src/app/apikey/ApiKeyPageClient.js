"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Input, Badge, Toggle } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { formatDateTime, formatCavemanLevel, CAVEMAN_LEVEL_IDS } from "@/shared/utils/format";

const STORAGE_KEY = "9r_apikey_value";
const PAGE_SIZE = 12;

const STATUS_META = {
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "warning" },
  expired: { label: "Expired", variant: "error" },
  exhausted: { label: "Quota reached", variant: "error" },
  unavailable: { label: "Not yet available", variant: "warning" },
  outside_hours: { label: "Outside authorized hours", variant: "warning" },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status || "Unknown", variant: "default" };
}

// ---- dashboard-aligned quota helpers (mirror EndpointPageClient rules) ----
function formatTokens(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function clampPercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Tone is driven by REMAINING percentage, matching the dashboard quota bars.
function barTone(remainingPercentage, exhausted = false) {
  const remaining = clampPercentage(remainingPercentage);
  if (exhausted || remaining <= 20) return "bg-red-500";
  if (remaining < 60) return "bg-yellow-500";
  return "bg-green-500";
}

function formatReset(value) {
  if (!value) return "no reset";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "no reset";
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "reset due";
  const minutes = Math.ceil(diffMs / 60000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return `resets in ${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
}

// Quota bar that follows the global dashboard rules: shows REMAINING (not used),
// tone by remaining %, "X / Y left", and reset countdown. Unlimited = full bar.
function QuotaBar({ label, used = 0, limit = null, resetAt = null, exhausted = false }) {
  const hasLimit = limit !== null && limit !== undefined && limit > 0;
  const remaining = hasLimit ? Math.max(0, limit - used) : null;
  const remainingPct = hasLimit ? clampPercentage((remaining / limit) * 100) : 100;
  const tone = hasLimit ? barTone(remainingPct, exhausted) : "bg-primary";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
        <span className="text-text-muted">{label}</span>
        <span className="font-medium text-text-main tabular-nums text-right">
          {hasLimit ? `${formatTokens(remaining)} / ${formatTokens(limit)} left` : "unlimited"}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${remainingPct}%` }} />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
        <span>{hasLimit ? `${remainingPct}% remaining` : "unlimited"}</span>
        {hasLimit && resetAt ? <span>{formatReset(resetAt)}</span> : <span>{used ? `${formatTokens(used)} used` : ""}</span>}
      </div>
    </div>
  );
}

function ModelRow({ model, apiKey }) {
  const [testState, setTestState] = useState("idle");
  const [testResult, setTestResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const copyName = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(model.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [model.id]);

  const runTest = useCallback(async () => {
    setTestState("running");
    setTestResult(null);
    const start = Date.now();
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model.id, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] }),
      });
      const latency = Date.now() - start;
      const text = await res.text().catch(() => "");
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok || parsed?.error) {
        const detail = parsed?.error?.message || parsed?.error || `HTTP ${res.status}`;
        setTestState("error");
        setTestResult({ ok: false, latency, message: String(detail).slice(0, 160) });
        return;
      }
      const ok = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
      setTestState(ok ? "ok" : "error");
      setTestResult({ ok, latency, message: ok ? `OK ${latency}ms` : "No completion returned" });
    } catch (err) {
      setTestState("error");
      setTestResult({ ok: false, message: err?.message || "Request failed" });
    }
  }, [apiKey, model.id]);

  return (
    <div className="flex items-center justify-between gap-2 p-3 rounded-[10px] border border-border-subtle bg-bg">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs sm:text-sm text-text-main truncate">{model.id}</span>
          {model.owned_by === "combo" && <Badge size="sm" variant="primary">combo</Badge>}
        </div>
        {testResult && (
          <p className={"text-xs mt-1 break-words " + (testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-500")}>
            {testResult.message}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={copyName} title="Copy model name">
          <span className="material-symbols-outlined text-[18px]">{copied ? "check" : "content_copy"}</span>
        </Button>
        <Button size="sm" variant="outline" onClick={runTest} loading={testState === "running"} disabled={testState === "running"}>
          Test
        </Button>
      </div>
    </div>
  );
}

const CAVEMAN_LEVELS = CAVEMAN_LEVEL_IDS;

// Self-service token-saver editor (shown when the admin allows key holders to
// edit their token saver). Persists via POST /api/apikey/settings.
function TokenSaverEditor({ apiKey, mode, initial, onSaved }) {
  const base = initial || {};
  const [rtk, setRtk] = useState(base.rtk === true);
  const [toon, setToon] = useState(base.toon === true);
  const [caveman, setCaveman] = useState(base.caveman === true);
  const [level, setLevel] = useState(typeof base.cavemanLevel === "string" ? base.cavemanLevel : "full");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = useCallback(async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/apikey/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ tokenSaver: { rtk, toon, caveman, cavemanLevel: level } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: body?.error || "Save failed" }); return; }
      setMsg({ ok: true, text: "Saved" });
      onSaved?.(body.tokenSaver);
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }, [apiKey, rtk, toon, caveman, level, onSaved]);

  return (
    <div className="flex flex-col gap-3">
      {mode !== "individual" && (
        <p className="text-xs text-yellow-600 dark:text-yellow-400">
          Global token-saver mode is active — your saved choices apply only when the admin switches to Individual mode.
        </p>
      )}
      <label className="flex items-center justify-between gap-3"><span className="text-sm text-text-main">Compress tool output (RTK)</span><Toggle size="sm" checked={rtk} onChange={() => setRtk((v) => !v)} /></label>
      <label className="flex items-center justify-between gap-3"><span className="text-sm text-text-main">Compress JSON output (TOON)</span><Toggle size="sm" checked={toon} onChange={() => setToon((v) => !v)} /></label>
      <label className="flex items-center justify-between gap-3"><span className="text-sm text-text-main">Compress LLM output (Caveman)</span><Toggle size="sm" checked={caveman} onChange={() => setCaveman((v) => !v)} /></label>
      {caveman && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-text-muted">Caveman level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded-[10px] border border-border-subtle bg-bg px-2 py-1.5 text-sm">
            {CAVEMAN_LEVELS.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
          </select>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" onClick={save} loading={saving} disabled={saving}>Save token saver</Button>
        {msg && <span className={"text-xs " + (msg.ok ? "text-green-600 dark:text-green-400" : "text-red-500")}>{msg.text}</span>}
      </div>
    </div>
  );
}

// Self-service overage editor (shown when the admin allows key holders to manage
// overage). Persists via POST /api/apikey/settings.
function OverageEditor({ apiKey, initial, onSaved }) {
  const base = initial || {};
  const maxLimit = Number.isFinite(Number(base.maxLimit)) && Number(base.maxLimit) > 0 ? Number(base.maxLimit) : null;
  const [enabled, setEnabled] = useState(base.enabled === true);
  const [limit, setLimit] = useState(base.limit ? String(base.limit) : (maxLimit ? String(maxLimit) : ""));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = useCallback(async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload = { overage: { enabled } };
      if (enabled) {
        let n = Math.floor(Number(limit));
        if (maxLimit && n > maxLimit) n = maxLimit;
        payload.overage.limit = n;
      }
      const res = await fetch("/api/apikey/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: body?.error || "Save failed" }); return; }
      setMsg({ ok: true, text: "Saved" });
      onSaved?.(body.overage);
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }, [apiKey, enabled, limit, maxLimit, onSaved]);

  return (
    <div className="mt-4 pt-4 border-t border-border-subtle flex flex-col gap-3">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-main">Enable overage pool</span>
        <Toggle size="sm" checked={enabled} onChange={() => setEnabled((v) => !v)} />
      </label>
      {enabled && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-text-muted">
            Overage limit (tokens){maxLimit ? ` — max ${maxLimit.toLocaleString()}` : ""}
          </span>
          <Input type="number" min="1" max={maxLimit || undefined} value={limit} onChange={(e) => setLimit(e.target.value)} className="max-w-[200px]" placeholder="e.g. 1000000" />
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" onClick={save} loading={saving} disabled={saving}>Save overage</Button>
        {msg && <span className={"text-xs " + (msg.ok ? "text-green-600 dark:text-green-400" : "text-red-500")}>{msg.text}</span>}
      </div>
    </div>
  );
}
// Self-service custom-instruction editor (shown when the admin allows key
// holders to manage it). Persists via POST /api/apikey/settings.
function CustomInstructionEditor({ apiKey, initial, onSaved }) {
  const base = initial || {};
  const [enabled, setEnabled] = useState(base.enabled === true);
  const [text, setText] = useState(typeof base.text === "string" ? base.text : "");
  const [injMode, setInjMode] = useState(["append", "prepend", "replace"].includes(base.mode) ? base.mode : "append");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = useCallback(async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload = { customInstruction: enabled ? { enabled: true, text, mode: injMode } : { enabled: false } };
      const res = await fetch("/api/apikey/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: body?.error || "Save failed" }); return; }
      setMsg({ ok: true, text: "Saved" });
      onSaved?.(body.customInstruction);
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }, [apiKey, enabled, text, injMode, onSaved]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-main">Enable custom instruction</span>
        <Toggle size="sm" checked={enabled} onChange={() => setEnabled((v) => !v)} />
      </label>
      {enabled && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="e.g. Always answer in British English."
            className="w-full rounded-[10px] border border-border-subtle bg-bg px-3 py-2 text-sm text-text-main resize-y"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-muted">Injection mode</span>
            {[["append", "Append"], ["prepend", "Prepend"], ["replace", "Replace"]].map(([val, label]) => (
              <button key={val} type="button" onClick={() => setInjMode(val)}
                className={"px-3 py-1.5 rounded-full text-xs font-medium border transition-colors " +
                  (injMode === val ? "bg-brand-500 text-white border-brand-500" : "bg-bg text-text-muted border-border-subtle hover:border-brand-500/40")}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" onClick={save} loading={saving} disabled={saving}>Save instruction</Button>
        {msg && <span className={"text-xs " + (msg.ok ? "text-green-600 dark:text-green-400" : "text-red-500")}>{msg.text}</span>}
      </div>
    </div>
  );
}

export default function ApiKeyPageClient() {
  const [keyInput, setKeyInput] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const lookup = useCallback(async (key) => {
    if (!key) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/apikey/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || "Unable to load key");
        setData(null);
        return;
      }
      setData(body);
      setActiveKey(key);
      try { sessionStorage.setItem(STORAGE_KEY, key); } catch {}
    } catch {
      setError("Network error. Try again.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stored = "";
    try { stored = sessionStorage.getItem(STORAGE_KEY) || ""; } catch {}
    if (stored) {
      setKeyInput(stored);
      lookup(stored);
    }
  }, [lookup]);

  const logout = useCallback(() => {
    setData(null);
    setActiveKey("");
    setKeyInput("");
    setError("");
    setSearch("");
    setPage(1);
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  const filteredModels = useMemo(() => {
    const list = data?.models || [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => m.id.toLowerCase().includes(q));
  }, [data, search]);

  useEffect(() => { setPage(1); }, [search]);

  const pagedModels = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredModels.slice(start, start + PAGE_SIZE);
  }, [filteredModels, page]);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg p-4 relative overflow-hidden">
        <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
        <div className="relative z-10 w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold text-text-main mb-2">API key dashboard</h1>
            <p className="text-text-muted">Enter your API key to view usage, quotas, and available models.</p>
          </div>
          <Card>
            <form
              onSubmit={(e) => { e.preventDefault(); lookup(keyInput); }}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">API key</label>
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  autoFocus
                  autoComplete="off"
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
              </div>
              <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!keyInput.trim()}>
                View key
              </Button>
              <p className="text-xs text-center text-text-muted">
                Read-only. Your key is kept in this browser tab only.
              </p>
            </form>
          </Card>
        </div>
      </div>
    );
  }

  const usage = data.usage || {};
  const limits = usage.limits || {};
  const periods = usage.periods || {};
  const sm = statusMeta(data.status);
  const ts = data.tokenSaver || {};
  const integ = data.settings || {};
  const perms = data.permissions || {};
  const tsConfig = data.tokenSaverConfig || null;
  const ci = data.customInstruction || {};
  const ciConfig = data.customInstructionConfig || null;
  const exhausted = data.status === "exhausted";
  const activeQuotaTiers = [
    { key: "daily", label: "Daily", limit: limits.daily?.limit ?? null, used: limits.daily?.used ?? 0, resetAt: limits.daily?.resetAt ?? periods.daily?.resetAt },
    { key: "weekly", label: "Weekly", limit: limits.weekly?.limit ?? null, used: limits.weekly?.used ?? 0, resetAt: limits.weekly?.resetAt ?? periods.weekly?.resetAt },
    { key: "monthly", label: "Monthly", limit: limits.monthly?.limit ?? null, used: limits.monthly?.used ?? 0, resetAt: limits.monthly?.resetAt ?? periods.monthly?.resetAt },
    { key: "hard", label: "Hard cap", limit: limits.hard?.limit ?? null, used: limits.hard?.used ?? 0, resetAt: null },
  ].filter((t) => t.limit != null);
  const savers = [
    { key: "rtk", label: "RTK", on: ts.rtk },
    { key: "toon", label: "TOON", on: ts.toon },
    { key: "caveman", label: "Caveman", on: ts.caveman, tag: ts.caveman ? formatCavemanLevel(ts.cavemanLevel) : "" },
  ];

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6 sm:py-8 flex flex-col gap-5 sm:gap-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base sm:text-lg font-semibold text-text-main truncate">{data.name || "API key"}</span>
            <Badge variant={sm.variant} dot>{sm.label}</Badge>
          </div>
          <Button size="sm" variant="outline" onClick={logout}>Sign out</Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          <Card padding="sm">
            <p className="text-sm text-text-muted">Total tokens consumed</p>
            <p className="text-xl sm:text-2xl font-bold text-text-main tabular-nums mt-1 break-all">{formatTokens(usage.totalUsed)}</p>
            <p className="text-xs text-text-muted mt-1">{formatTokens(usage.totalRequests)} requests</p>
          </Card>
          <Card padding="sm">
            <p className="text-sm text-text-muted">Today</p>
            <p className="text-xl sm:text-2xl font-bold text-text-main tabular-nums mt-1 break-all">{formatTokens(periods.daily?.used)}</p>
            <p className="text-xs text-text-muted mt-1">resets {formatDateTime(periods.daily?.resetAt)}</p>
          </Card>
          <Card padding="sm">
            <p className="text-sm text-text-muted">Expires</p>
            <p className="text-base sm:text-lg font-semibold text-text-main mt-1">{data.expiresAt ? formatDateTime(data.expiresAt) : "Never"}</p>
            <p className="text-xs text-text-muted mt-1">created {formatDateTime(data.createdAt)}</p>
          </Card>
        </div>

        <Card title="Quotas" icon="speed">
          {activeQuotaTiers.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
              {activeQuotaTiers.map((t) => (
                <QuotaBar key={t.key} label={t.label} used={t.used} limit={t.limit} resetAt={t.resetAt} exhausted={exhausted} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">No quota limits on this key — usage is unlimited.</p>
          )}
          {usage.overage && (usage.overage.enabled || usage.overage.used > 0) && (
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <QuotaBar label="Overage pool" used={usage.overage.used ?? 0} limit={usage.overage.limit ?? null} exhausted={usage.overage.exhausted} />
              <p className="text-xs text-text-muted mt-1">
                {usage.overage.enabled ? (usage.overage.windowActive ? "Active" : "Inactive") : "Disabled"}
                {usage.overage.exhausted ? " · exhausted" : ""}
              </p>
            </div>
          )}
          {perms.overage && (
            <OverageEditor
              apiKey={activeKey}
              initial={usage.overage}
              onSaved={() => lookup(activeKey)}
            />
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-4 border-t border-border-subtle text-center">
            <div><p className="text-xs text-text-muted">Daily</p><p className="font-semibold tabular-nums break-all">{formatTokens(periods.daily?.used)}</p></div>
            <div><p className="text-xs text-text-muted">Weekly</p><p className="font-semibold tabular-nums break-all">{formatTokens(periods.weekly?.used)}</p></div>
            <div><p className="text-xs text-text-muted">Monthly</p><p className="font-semibold tabular-nums break-all">{formatTokens(periods.monthly?.used)}</p></div>
            <div><p className="text-xs text-text-muted">All time</p><p className="font-semibold tabular-nums break-all">{formatTokens(periods.allTime?.used)}</p></div>
          </div>
        </Card>

        <Card title="Token saver" icon="bolt" subtitle={`Mode: ${ts.mode === "individual" ? "Per-key" : "Global"}${perms.tokenSaver ? "" : " (display only)"}`}>
          <div className="flex flex-wrap gap-2 sm:gap-3">
            {savers.map((s) => (
              <div key={s.key} className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-border-subtle bg-bg">
                <span className={"size-2 rounded-full " + (s.on ? "bg-green-500" : "bg-gray-400")} />
                <span className="text-sm text-text-main">{s.label}</span>
                {s.tag && <Badge size="sm" variant="primary">{s.tag}</Badge>}
                <Badge size="sm" variant={s.on ? "success" : "default"}>{s.on ? "Active" : "Off"}</Badge>
              </div>
            ))}
          </div>
          {perms.tokenSaver && (
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <p className="text-sm font-medium text-text-main mb-3">Edit your token saver</p>
              <TokenSaverEditor
                apiKey={activeKey}
                mode={perms.tokenSaverMode || ts.mode}
                initial={tsConfig}
                onSaved={() => lookup(activeKey)}
              />
            </div>
          )}
        </Card>

        <Card title="Custom instruction" icon="edit_note" subtitle={`Mode: ${ci.mode === "individual" ? "Per-key" : "Global"}${perms.customInstruction ? "" : " (display only)"}`}>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-border-subtle bg-bg">
              <span className={"size-2 rounded-full " + (ci.enabled ? "bg-green-500" : "bg-gray-400")} />
              <span className="text-sm text-text-main">{ci.enabled ? ({ append: "Appended to system prompt", prepend: "Prepended to system prompt", replace: "Replaces system prompt" })[ci.injectMode || "append"] : "No custom instruction"}</span>
              <Badge size="sm" variant={ci.enabled ? "success" : "default"}>{ci.enabled ? "Active" : "Disabled"}</Badge>
            </div>
          </div>
          {ci.enabled && ci.preview && (
            <p className="mt-3 text-xs text-text-muted whitespace-pre-wrap break-words rounded-[10px] border border-border-subtle bg-bg p-3">{ci.preview}{ci.preview.length >= 280 ? "…" : ""}</p>
          )}
          {perms.customInstruction && (
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <p className="text-sm font-medium text-text-main mb-3">Edit your custom instruction</p>
              {ci.mode !== "individual" && (
                <p className="mb-3 text-xs text-yellow-600 dark:text-yellow-400">Global mode is active — your saved instruction applies only when the admin switches to Individual mode.</p>
              )}
              <CustomInstructionEditor apiKey={activeKey} initial={ciConfig} onSaved={() => lookup(activeKey)} />
            </div>
          )}
        </Card>

        <Card title="Settings" icon="tune" subtitle="Integration behavior applied to this key (not a token saver).">
          <div className="flex flex-wrap gap-2 sm:gap-3">
            <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-border-subtle bg-bg">
              <span className={"size-2 rounded-full " + (integ.codexUsage ? "bg-green-500" : "bg-gray-400")} />
              <span className="text-sm text-text-main">Codex usage forwarding</span>
              <Badge size="sm" variant={integ.codexUsage ? "success" : "default"}>{integ.codexUsage ? "Active" : "Off"}</Badge>
            </div>
          </div>
        </Card>

        <Card title="Available models" icon="lan" subtitle={`${filteredModels.length} model${filteredModels.length === 1 ? "" : "s"} available to this key`}>
          <div className="flex justify-center mb-5">
            <div className="w-full max-w-md">
              <Input
                placeholder="Search models..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          {filteredModels.length === 0 ? (
            <p className="text-center text-sm text-text-muted py-8">
              {data.models?.length ? "No models match your search." : "No models available to this key."}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {pagedModels.map((m) => (
                  <ModelRow key={m.id} model={m} apiKey={activeKey} />
                ))}
              </div>
              <Pagination
                currentPage={page}
                pageSize={PAGE_SIZE}
                totalItems={filteredModels.length}
                onPageChange={setPage}
              />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
