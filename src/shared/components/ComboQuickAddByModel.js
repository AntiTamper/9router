"use client";

import { useState } from "react";

const VALID_COMBO_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

function normalizeKind(kindFilter) {
  return kindFilter || "llm";
}

function canUseAsComboName(modelId) {
  return typeof modelId === "string" && VALID_COMBO_NAME_REGEX.test(modelId);
}

export default function ComboQuickAddByModel({ models, onModelsChange, onNameCandidate, kindFilter = null }) {
  const [targetModel, setTargetModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const handleQuickAdd = async () => {
    const query = targetModel.trim();
    if (!query || loading) return;
    setLoading(true);
    setStatus(null);

    try {
      const params = new URLSearchParams({ model: query, kind: normalizeKind(kindFilter), live: "1" });
      const res = await fetch(`/api/models/matching?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Match failed");

      const values = (data.matches || []).map((m) => m.id).filter(Boolean);
      if (values.length === 0) {
        setStatus({ type: "empty", text: "No matching active providers" });
        return;
      }

      const current = new Set(models);
      const added = values.filter((value) => !current.has(value));
      if (added.length > 0) onModelsChange([...models, ...added]);

      if (canUseAsComboName(data.targetModel)) {
        onNameCandidate?.(data.targetModel);
      }

      setStatus({
        type: "success",
        text: added.length > 0 ? `Added ${added.length} of ${values.length}` : `Already added ${values.length}`,
      });
    } catch (error) {
      setStatus({ type: "error", text: error.message || "Match failed" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border-subtle bg-black/[0.015] p-2.5 dark:bg-white/[0.015]">
      <label className="mb-1 block text-xs font-medium text-text-muted">Quick add by model ID</label>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">search</span>
          <input
            value={targetModel}
            onChange={(e) => setTargetModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleQuickAdd(); }}
            placeholder="claude-sonnet-4-5-20250929"
            className="w-full rounded border border-border bg-surface py-1.5 pl-8 pr-2 font-mono text-xs text-text-main outline-none focus:border-primary"
          />
        </div>
        <button
          type="button"
          onClick={handleQuickAdd}
          disabled={!targetModel.trim() || loading}
          className="inline-flex items-center justify-center gap-1 rounded border border-primary/30 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:border-primary/60 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[15px]">playlist_add</span>
          {loading ? "Matching..." : "Add Matches"}
        </button>
      </div>
      {status?.text && (
        <p className={`mt-1 text-[10px] ${status.type === "error" ? "text-red-500" : status.type === "success" ? "text-green-600 dark:text-green-400" : "text-text-muted"}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

