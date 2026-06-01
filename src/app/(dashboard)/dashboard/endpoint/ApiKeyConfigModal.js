"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Button, Input, Toggle } from "@/shared/components";
import { formatNumber, isoToLocalInput, localInputToIso } from "@/shared/utils/format";

const CAVEMAN_LEVELS = ["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"];

// Parse a localized/number string ("100,000,000") to a positive int or null.
function toInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.floor(Number(String(value).replace(/[, ]/g, "")));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Empty -> form state. Hydrates from an existing key's structured config.
function initState(key) {
  const cfg = key?.config || {};
  const limits = cfg.limits || {};
  const dw = cfg.dailyWindow || null;
  const av = cfg.availability || null;
  const ts = cfg.tokenSaver || null;
  const ex = cfg.exposure || { mode: "all", combo: null };
  const ov = cfg.overage || null;
  return {
    name: key?.name || "",
    isActive: key?.isActive !== false,
    autoDeleteExpired: key?.autoDeleteExpired !== false,
    dailyOn: limits.daily != null,
    weeklyOn: limits.weekly != null,
    monthlyOn: limits.monthly != null,
    daily: limits.daily != null ? String(limits.daily) : "",
    weekly: limits.weekly != null ? String(limits.weekly) : "",
    monthly: limits.monthly != null ? String(limits.monthly) : "",
    hardOn: limits.hard != null,
    hard: limits.hard != null ? String(limits.hard) : "",
    dailyWindowOn: !!dw,
    windowStart: dw?.start || "09:00",
    windowEnd: dw?.end || "17:00",
    expiryMode: key?.expiresAt ? "date" : (av ? "window" : "none"),
    expiresAt: isoToLocalInput(key?.expiresAt),
    availableFrom: isoToLocalInput(av?.availableFrom),
    availableUntil: isoToLocalInput(av?.availableUntil),
    tokenSaverOn: !!ts,
    tsRtk: ts?.rtk === true,
    tsToon: ts?.toon === true,
    tsCaveman: ts?.caveman === true,
    tsCavemanLevel: ts?.cavemanLevel || "full",
    tsCodexUsage: ts?.codexUsage !== false,
    exposureMode: ex.mode === "combo" ? "combo" : "all",
    exposureCombo: ex.combo || "",
    overageOn: !!(ov && ov.enabled),
    overageLimit: ov?.limit != null ? String(ov.limit) : "",
  };
}

// Builds the structured config payload (+ timers) for POST/PUT /api/keys.
function buildPayload(s, { create }) {
  const limits = {
    daily: s.dailyOn ? toInt(s.daily) : null,
    weekly: s.weeklyOn ? toInt(s.weekly) : null,
    monthly: s.monthlyOn ? toInt(s.monthly) : null,
    hard: s.hardOn ? toInt(s.hard) : null,
  };
  const config = {
    limits,
    dailyWindow: s.dailyWindowOn ? { start: s.windowStart, end: s.windowEnd } : null,
    availability: s.expiryMode === "window"
      ? { availableFrom: localInputToIso(s.availableFrom), availableUntil: localInputToIso(s.availableUntil) }
      : null,
    tokenSaver: s.tokenSaverOn
      ? { rtk: s.tsRtk, toon: s.tsToon, caveman: s.tsCaveman, cavemanLevel: s.tsCavemanLevel, codexUsage: s.tsCodexUsage }
      : null,
    exposure: s.exposureMode === "combo"
      ? { mode: "combo", combo: s.exposureCombo }
      : { mode: "all", combo: null },
    overage: s.overageOn ? { enabled: true, limit: toInt(s.overageLimit) } : null,
  };
  const payload = { name: s.name.trim(), config, autoDeleteExpired: s.autoDeleteExpired };
  if (!create) payload.isActive = s.isActive;
  // Expiry: date window picks expiresAt; "none" clears it; "window" mode uses
  // availability (above) and leaves expiresAt cleared.
  if (s.expiryMode === "date") payload.expiresAt = localInputToIso(s.expiresAt);
  else payload.expiresAt = null;
  return payload;
}

// Validate the form; returns an error string or null.
function validate(s) {
  if (!s.name.trim()) return "Key name is required";
  if (s.dailyOn && !toInt(s.daily)) return "Daily limit must be a positive number";
  if (s.weeklyOn && !toInt(s.weekly)) return "Weekly limit must be a positive number";
  if (s.monthlyOn && !toInt(s.monthly)) return "Monthly limit must be a positive number";
  if (s.hardOn && !toInt(s.hard)) return "Hard cap must be a positive number";
  if (s.dailyWindowOn && (!s.windowStart || !s.windowEnd)) return "Daily window needs start and end";
  if (s.expiryMode === "date" && !s.expiresAt) return "Pick an expiry date";
  if (s.expiryMode === "window" && !s.availableFrom && !s.availableUntil) return "Set an availability window";
  if (s.exposureMode === "combo" && !s.exposureCombo) return "Choose a combo for combo exposure";
  if (s.overageOn && !toInt(s.overageLimit)) return "Overage limit must be a positive number";
  return null;
}

function Section({ title, hint, children }) {
  return (
    <div className="rounded-[10px] border border-border-subtle bg-bg p-3 flex flex-col gap-3">
      <div>
        <p className="text-sm font-semibold text-text-main">{title}</p>
        {hint && <p className="text-xs text-text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

// A token-limit row: a toggle to enable, plus a formatted number input.
function LimitRow({ label, on, onToggle, value, onValue, placeholder }) {
  const preview = on && value ? formatNumber(String(value).replace(/[, ]/g, "")) : null;
  return (
    <div className="flex items-center gap-3">
      <Toggle size="sm" checked={on} onChange={onToggle} />
      <span className="text-sm text-text-main w-20 shrink-0">{label}</span>
      <div className="flex-1 min-w-0">
        <input
          type="text"
          inputMode="numeric"
          disabled={!on}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          placeholder={placeholder}
          className="h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-sm text-text-main disabled:opacity-50 tabular-nums"
        />
        {preview && <p className="text-[11px] text-text-muted mt-0.5 tabular-nums">{preview} tokens</p>}
      </div>
    </div>
  );
}

// Structured create/edit modal for an API key. `mode` is "create" or "edit".
// `combos` is the list of combo objects ({name,...}) for the exposure picker.
// onSaved(updatedOrCreatedKey, { created }) fires after a successful save.
export default function ApiKeyConfigModal({ isOpen, mode, apiKey, combos = [], tokenSaverMode = "global", onClose, onSaved, onReset }) {
  const create = mode === "create";
  const [s, setS] = useState(() => initState(apiKey));
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setS(initState(apiKey));
      setErr("");
      setSaving(false);
    }
  }, [isOpen, apiKey]);

  const set = useCallback((patch) => setS((prev) => ({ ...prev, ...patch })), []);

  const fusionCount = (s.dailyOn ? 1 : 0) + (s.weeklyOn ? 1 : 0) + (s.monthlyOn ? 1 : 0);

  const submit = useCallback(async () => {
    const v = validate(s);
    if (v) { setErr(v); return; }
    setErr("");
    setSaving(true);
    try {
      const payload = buildPayload(s, { create });
      const url = create ? "/api/keys" : `/api/keys/${apiKey.id}`;
      const res = await fetch(url, {
        method: create ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data?.error || "Save failed"); return; }
      onSaved?.(data, { created: create });
    } catch {
      setErr("Network error");
    } finally {
      setSaving(false);
    }
  }, [s, create, apiKey, onSaved]);

  return (
    <Modal
      isOpen={isOpen}
      title={create ? "Create API Key" : `Edit Key: ${apiKey?.name || ""}`}
      size="lg"
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto pr-1">
        <Input
          label="Key name"
          value={s.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Production key"
        />

        {!create && (
          <div className="flex items-center justify-between rounded-[10px] border border-border-subtle bg-bg px-3 py-2">
            <span className="text-sm font-medium text-text-main">Key enabled</span>
            <Toggle size="sm" checked={s.isActive} onChange={(c) => set({ isActive: c })} />
          </div>
        )}

        <Section title="Fusion limits" hint={`Pair any of daily / weekly / monthly. ${fusionCount >= 2 ? `Fusion active (${fusionCount}).` : "Enable 2+ to fuse."}`}>
          <LimitRow label="Daily" on={s.dailyOn} onToggle={(c) => set({ dailyOn: c })} value={s.daily} onValue={(v) => set({ daily: v })} placeholder="5,000,000" />
          <LimitRow label="Weekly" on={s.weeklyOn} onToggle={(c) => set({ weeklyOn: c })} value={s.weekly} onValue={(v) => set({ weekly: v })} placeholder="20,000,000" />
          <LimitRow label="Monthly" on={s.monthlyOn} onToggle={(c) => set({ monthlyOn: c })} value={s.monthly} onValue={(v) => set({ monthly: v })} placeholder="80,000,000" />
        </Section>

        <Section title="Hard cap" hint="Counts from when you set it (re-anchors on reset). Independent of time windows.">
          <LimitRow label="Hard cap" on={s.hardOn} onToggle={(c) => set({ hardOn: c })} value={s.hard} onValue={(v) => set({ hard: v })} placeholder="100,000,000" />
        </Section>

        <Section title="Overage pool" hint="Optional extra tokens usable after timed limits are hit.">
          <LimitRow label="Overage" on={s.overageOn} onToggle={(c) => set({ overageOn: c })} value={s.overageLimit} onValue={(v) => set({ overageLimit: v })} placeholder="10,000,000" />
        </Section>

        <Section title="Daily authorized hours" hint="Restrict use to a time window each day (overnight ranges allowed).">
          <div className="flex items-center gap-3">
            <Toggle size="sm" checked={s.dailyWindowOn} onChange={(c) => set({ dailyWindowOn: c })} />
            <input type="time" disabled={!s.dailyWindowOn} value={s.windowStart} onChange={(e) => set({ windowStart: e.target.value })}
              className="h-9 rounded-[8px] border border-border bg-surface px-3 text-sm text-text-main disabled:opacity-50" />
            <span className="text-text-muted text-sm">to</span>
            <input type="time" disabled={!s.dailyWindowOn} value={s.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })}
              className="h-9 rounded-[8px] border border-border bg-surface px-3 text-sm text-text-main disabled:opacity-50" />
          </div>
        </Section>

        <Section title="Expiry" hint="Expire on a date, or limit to an availability window. Auto-delete removes the key once expired.">
          <div className="flex flex-wrap gap-2">
            {[["none", "Never"], ["date", "Expire on date"], ["window", "Available window"]].map(([val, label]) => (
              <button key={val} type="button" onClick={() => set({ expiryMode: val })}
                className={"px-3 py-1.5 rounded-full text-xs font-medium border transition-colors " +
                  (s.expiryMode === val ? "bg-brand-500 text-white border-brand-500" : "bg-surface text-text-muted border-border-subtle hover:border-brand-500/40")}>
                {label}
              </button>
            ))}
          </div>
          {s.expiryMode === "date" && (
            <Input label="Expires at" type="datetime-local" value={s.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
          )}
          {s.expiryMode === "window" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Available from" type="datetime-local" value={s.availableFrom} onChange={(e) => set({ availableFrom: e.target.value })} />
              <Input label="Available until" type="datetime-local" value={s.availableUntil} onChange={(e) => set({ availableUntil: e.target.value })} />
            </div>
          )}
          <div className="flex items-center justify-between rounded-[8px] border border-border-subtle px-3 py-2">
            <span className="text-sm text-text-main">Delete key once expired</span>
            <Toggle size="sm" checked={s.autoDeleteExpired} onChange={(c) => set({ autoDeleteExpired: c })} />
          </div>
        </Section>

        <Section title="Model exposure" hint="Expose all global models, or restrict this key to a single combo.">
          <div className="flex flex-wrap gap-2">
            {[["all", "All global models"], ["combo", "Specific combo"]].map(([val, label]) => (
              <button key={val} type="button" onClick={() => set({ exposureMode: val })}
                className={"px-3 py-1.5 rounded-full text-xs font-medium border transition-colors " +
                  (s.exposureMode === val ? "bg-brand-500 text-white border-brand-500" : "bg-surface text-text-muted border-border-subtle hover:border-brand-500/40")}>
                {label}
              </button>
            ))}
          </div>
          {s.exposureMode === "combo" && (
            <select value={s.exposureCombo} onChange={(e) => set({ exposureCombo: e.target.value })}
              className="h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-sm text-text-main">
              <option value="">Select a combo...</option>
              {combos.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          )}
        </Section>

        <Section title="Token saver" hint={tokenSaverMode === "individual"
          ? "Individual mode is active globally — these per-key settings apply to this key."
          : "Global mode is active — per-key settings are stored but only used when you switch the global mode to Individual."}>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-main">Use per-key token saver</span>
            <Toggle size="sm" checked={s.tokenSaverOn} onChange={(c) => set({ tokenSaverOn: c })} />
          </div>
          {s.tokenSaverOn && (
            <div className="flex flex-col gap-2 pl-1">
              <label className="flex items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={s.tsRtk} onChange={(e) => set({ tsRtk: e.target.checked })} /> RTK</label>
              <label className="flex items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={s.tsToon} onChange={(e) => set({ tsToon: e.target.checked })} /> TOON</label>
              <label className="flex items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={s.tsCaveman} onChange={(e) => set({ tsCaveman: e.target.checked })} /> Caveman</label>
              {s.tsCaveman && (
                <select value={s.tsCavemanLevel} onChange={(e) => set({ tsCavemanLevel: e.target.value })}
                  className="h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-sm text-text-main">
                  {CAVEMAN_LEVELS.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
                </select>
              )}
              <label className="flex items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={s.tsCodexUsage} onChange={(e) => set({ tsCodexUsage: e.target.checked })} /> Forward Codex usage</label>
            </div>
          )}
        </Section>

        {!create && (
          <Section title="Reset usage" hint="Re-anchor or clear a specific quota without touching others.">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Button variant="outline" size="sm" onClick={() => onReset?.(apiKey, "daily")}>Daily</Button>
              <Button variant="outline" size="sm" onClick={() => onReset?.(apiKey, "weekly")}>Weekly</Button>
              <Button variant="outline" size="sm" onClick={() => onReset?.(apiKey, "monthly")}>Monthly</Button>
              <Button variant="outline" size="sm" onClick={() => onReset?.(apiKey, "hard")}>Hard cap</Button>
              <Button variant="outline" size="sm" onClick={() => onReset?.(apiKey, "overage")}>Overage</Button>
              <Button variant="danger" size="sm" onClick={() => onReset?.(apiKey, "all")}>All</Button>
            </div>
          </Section>
        )}

        {err && <p className="text-sm text-red-500">{err}</p>}
      </div>

      <div className="flex gap-2 mt-4">
        <Button onClick={submit} loading={saving} disabled={saving} fullWidth>
          {create ? "Create key" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onClose} fullWidth>Cancel</Button>
      </div>
    </Modal>
  );
}
