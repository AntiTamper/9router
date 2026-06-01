"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Input, Badge, Toggle } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { formatNumber, formatLimit, formatDateTime } from "@/shared/utils/format";

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

function QuotaBar({ label, used, limit }) {
  const hasLimit = limit !== null && limit !== undefined;
  const pct = hasLimit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const danger = hasLimit && pct >= 90;
  const warn = hasLimit && pct >= 70 && pct < 90;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-muted">{label}</span>
        <span className="font-medium text-text-main tabular-nums">
          {formatNumber(used)} / {formatLimit(limit)}
        </span>
      </div>
      {hasLimit ? (
        <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
          <div
            className={
              "h-full rounded-full transition-all " +
              (danger ? "bg-red-500" : warn ? "bg-yellow-500" : "bg-brand-500")
            }
            style={{ width: pct + "%" }}
          />
        </div>
      ) : (
        <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
          <div className="h-full w-full bg-gradient-to-r from-brand-500/30 to-brand-500/10" />
        </div>
      )}
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
    <div className="flex items-center justify-between gap-3 p-3 rounded-[10px] border border-border-subtle bg-bg">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-text-main truncate">{model.id}</span>
          {model.owned_by === "combo" && <Badge size="sm" variant="primary">combo</Badge>}
        </div>
        {testResult && (
          <p className={"text-xs mt-1 " + (testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-500")}>
            {testResult.message}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
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

export default function ApiKeyPageClient() {
  const [keyInput, setKeyInput] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const lookup = useCallback(async (value) => {
    const key = (value || "").trim();
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
            <h1 className="text-3xl font-bold text-primary mb-2">9Router</h1>
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
  const savers = [
    { key: "rtk", label: "RTK", on: ts.rtk },
    { key: "toon", label: "TOON", on: ts.toon },
    { key: "caveman", label: `Caveman${ts.caveman ? ` (${ts.cavemanLevel || "full"})` : ""}`, on: ts.caveman },
    { key: "codexUsage", label: "Codex usage", on: ts.codexUsage },
  ];

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-5xl mx-auto px-4 py-8 flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-primary">9Router</h1>
            <Badge variant={sm.variant} dot>{sm.label}</Badge>
          </div>
          <div className="flex items-center gap-3">
            {data.name && <span className="text-sm text-text-muted">Key: <span className="text-text-main font-medium">{data.name}</span></span>}
            <Button size="sm" variant="outline" onClick={logout}>Sign out</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card padding="sm">
            <p className="text-sm text-text-muted">Total tokens consumed</p>
            <p className="text-2xl font-bold text-text-main tabular-nums mt-1">{formatNumber(usage.totalUsed)}</p>
            <p className="text-xs text-text-muted mt-1">{formatNumber(usage.totalRequests)} requests</p>
          </Card>
          <Card padding="sm">
            <p className="text-sm text-text-muted">Today</p>
            <p className="text-2xl font-bold text-text-main tabular-nums mt-1">{formatNumber(periods.daily?.used)}</p>
            <p className="text-xs text-text-muted mt-1">resets {formatDateTime(periods.daily?.resetAt)}</p>
          </Card>
          <Card padding="sm">
            <p className="text-sm text-text-muted">Expires</p>
            <p className="text-lg font-semibold text-text-main mt-1">{data.expiresAt ? formatDateTime(data.expiresAt) : "Never"}</p>
            <p className="text-xs text-text-muted mt-1">created {formatDateTime(data.createdAt)}</p>
          </Card>
        </div>

        <Card title="Quotas" icon="speed">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
            <QuotaBar label="Daily" used={limits.daily?.used ?? 0} limit={limits.daily?.limit ?? null} />
            <QuotaBar label="Weekly" used={limits.weekly?.used ?? 0} limit={limits.weekly?.limit ?? null} />
            <QuotaBar label="Monthly" used={limits.monthly?.used ?? 0} limit={limits.monthly?.limit ?? null} />
            <QuotaBar label="Hard cap" used={limits.hard?.used ?? 0} limit={limits.hard?.limit ?? null} />
          </div>
          {usage.overage && usage.overage.enabled && (
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <QuotaBar label="Overage pool" used={usage.overage.used ?? 0} limit={usage.overage.limit ?? null} />
              <p className="text-xs text-text-muted mt-1">
                {usage.overage.windowActive ? "Active" : "Inactive"}
                {usage.overage.exhausted ? " · exhausted" : ""}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-4 border-t border-border-subtle text-center">
            <div><p className="text-xs text-text-muted">Daily</p><p className="font-semibold tabular-nums">{formatNumber(periods.daily?.used)}</p></div>
            <div><p className="text-xs text-text-muted">Weekly</p><p className="font-semibold tabular-nums">{formatNumber(periods.weekly?.used)}</p></div>
            <div><p className="text-xs text-text-muted">Monthly</p><p className="font-semibold tabular-nums">{formatNumber(periods.monthly?.used)}</p></div>
            <div><p className="text-xs text-text-muted">All time</p><p className="font-semibold tabular-nums">{formatNumber(periods.allTime?.used)}</p></div>
          </div>
        </Card>

        <Card title="Token saver" icon="bolt" subtitle={`Mode: ${ts.mode === "individual" ? "Per-key" : "Global"} (display only)`}>
          <div className="flex flex-wrap gap-3">
            {savers.map((s) => (
              <div key={s.key} className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-border-subtle bg-bg">
                <span className={"size-2 rounded-full " + (s.on ? "bg-green-500" : "bg-gray-400")} />
                <span className="text-sm text-text-main">{s.label}</span>
                <span className="text-xs text-text-muted">{s.on ? "on" : "off"}</span>
              </div>
            ))}
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
