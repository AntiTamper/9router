"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import Toggle from "@/shared/components/Toggle";
import { calculatePercentage, buildProviderQuotaAverages } from "./utils";
import {
  fetchQuotaWithCache,
  getCachedQuotaDataForConnections,
  removeQuotaCacheEntries,
} from "./quotaCache";
import Card from "@/shared/components/Card";
import { EditConnectionModal } from "@/shared/components";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Connection is eligible for the quota page when it uses OAuth or is an apikey provider whitelisted for quota
const isUsageEligible = (conn) =>
  USAGE_SUPPORTED_PROVIDERS.includes(conn.provider) &&
  (conn.authType === "oauth" || USAGE_APIKEY_PROVIDERS.includes(conn.provider));

const DEPLETED_QUOTA_THRESHOLD = 5; // percent
const AUTO_REFRESH_STORAGE_KEY = "quotaAutoRefresh";
const REFRESH_INTERVAL_STORAGE_KEY = "quotaRefreshIntervalMs";
const UI_SETTINGS_STORAGE_KEY = "quotaTrackerUiSettings:v1";
const DEFAULT_REFRESH_INTERVAL_MS = 60000;
const REFRESH_INTERVAL_OPTIONS = [
  { label: "Manual", value: 0 },
  { label: "1m", value: 60000 },
  { label: "5m", value: 300000 },
  { label: "15m", value: 900000 },
];

function isPageVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function readQuotaUiSettings() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function normalizeRefreshIntervalMs(value, fallback = DEFAULT_REFRESH_INTERVAL_MS) {
  const interval = Number(value);
  return REFRESH_INTERVAL_OPTIONS.some((option) => option.value === interval)
    ? interval
    : fallback;
}

function readRefreshIntervalMs() {
  if (typeof window === "undefined") return DEFAULT_REFRESH_INTERVAL_MS;
  const storedInterval = window.localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
  if (storedInterval !== null) return normalizeRefreshIntervalMs(storedInterval);
  const legacyAuto = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
  return legacyAuto === "false" ? 0 : DEFAULT_REFRESH_INTERVAL_MS;
}

function getProviderSortOrder(provider) {
  const order = USAGE_SUPPORTED_PROVIDERS.indexOf(provider);
  return order === -1 ? Number.MAX_SAFE_INTEGER : order;
}

export default function ProviderLimits() {
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [quotaCompleted, setQuotaCompleted] = useState({});
  const [errors, setErrors] = useState({});
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(DEFAULT_REFRESH_INTERVAL_MS);
  const [quotaAutoToggleEnabled, setQuotaAutoToggleEnabled] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(() => Math.max(1, Math.round(DEFAULT_REFRESH_INTERVAL_MS / 1000)));
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [providerFilter, setProviderFilter] = useState("all");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [settingsSyncReady, setSettingsSyncReady] = useState(false);
  const [collapsedProviders, setCollapsedProviders] = useState({});

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);

  const clearRefreshTimers = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  // Fetch all provider connections
  const fetchConnections = useCallback(async () => {
    try {
      const response = await fetch("/api/providers/client");
      if (!response.ok) throw new Error("Failed to fetch connections");

      const data = await response.json();
      const connectionList = data.connections || [];
      setConnections(connectionList);
      return connectionList;
    } catch (error) {
      console.error("Error fetching connections:", error);
      setConnections([]);
      return [];
    }
  }, []);

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connection, { force = false } = {}) => {
    const connectionId = connection?.id;
    const provider = connection?.provider;
    if (!connectionId || !provider) return;
    if (!force && !isPageVisible()) return;

    const cached = !force
      ? getCachedQuotaDataForConnections([connection])[connectionId]
      : null;
    if (cached) {
      setQuotaData((prev) => ({ ...prev, [connectionId]: cached }));
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
      setQuotaCompleted((prev) => ({ ...prev, [connectionId]: true }));
      setErrors((prev) => ({ ...prev, [connectionId]: null }));
      return;
    }

    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setQuotaCompleted((prev) => ({ ...prev, [connectionId]: false }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      console.log(
        `[ProviderLimits] Fetching quota for ${provider} (${connectionId})`,
      );
      const { entry, notFound, stale } = await fetchQuotaWithCache(connection, {
        force,
      });

      if (notFound) {
        setQuotaData((prev) => {
          const next = { ...prev };
          delete next[connectionId];
          return next;
        });
        return;
      }

      if (entry) {
        if (stale) {
          console.warn(
            `[ProviderLimits] Using cached quota for ${provider} (${connectionId})`,
          );
        }
        setQuotaData((prev) => ({ ...prev, [connectionId]: entry }));
      }
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
      setQuotaCompleted((prev) => ({ ...prev, [connectionId]: true }));
    }
  }, []);

  // Refresh quota for a specific provider
  const refreshProvider = useCallback(
    async (connection) => {
      await fetchQuota(connection, { force: true });
      await fetchConnections();
      setLastUpdated(new Date());
    },
    [fetchQuota, fetchConnections],
  );

  const handleDeleteConnection = useCallback(async (id) => {
    if (!confirm("Delete this connection?")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
      if (res.ok) {
        removeQuotaCacheEntries([id]);
        setConnections((prev) => prev.filter((c) => c.id !== id));
        setQuotaData((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setLoading((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setQuotaCompleted((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setErrors((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    } catch (error) {
      console.error("Error deleting connection:", error);
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleToggleConnectionActive = useCallback(async (id, isActive) => {
    setTogglingId(id);
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setConnections((prev) =>
          prev.map((c) => (c.id === id ? { ...c, isActive } : c)),
        );
      }
    } catch (error) {
      console.error("Error updating connection status:", error);
    } finally {
      setTogglingId(null);
    }
  }, []);

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(selectedConnection, { force: true });
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const uiSettings = readQuotaUiSettings();
    if (uiSettings.providerFilter) setProviderFilter(uiSettings.providerFilter);
    if (uiSettings.expiringFirst === true) setExpiringFirst(true);
    if (uiSettings.collapsedProviders && typeof uiSettings.collapsedProviders === "object") {
      setCollapsedProviders(uiSettings.collapsedProviders);
    }

    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setQuotaAutoToggleEnabled(data.quotaAutoToggleEnabled !== false);
        const persistedInterval = normalizeRefreshIntervalMs(
          data?.quotaRefreshIntervalMs,
          readRefreshIntervalMs(),
        );
        setRefreshIntervalMs(persistedInterval);
        setSettingsSyncReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleQuotaAutoToggle = useCallback(async () => {
    const next = !quotaAutoToggleEnabled;
    setQuotaAutoToggleEnabled(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaAutoToggleEnabled: next }),
      });
      if (!res.ok) setQuotaAutoToggleEnabled(!next);
    } catch (error) {
      console.error("Error updating quota auto toggle:", error);
      setQuotaAutoToggleEnabled(!next);
    }
  }, [quotaAutoToggleEnabled]);

  // Refresh all providers
  const refreshAll = useCallback(async () => {
    if (refreshingAll) return;
    if (!isPageVisible()) return;

    setRefreshingAll(true);
    setCountdown(Math.max(1, Math.round(refreshIntervalMs / 1000)));

    try {
      const conns = await fetchConnections();

      // Filter eligible connections (OAuth + whitelisted apikey)
      const eligibleConnections = conns.filter(isUsageEligible);
      const loadingState = {};
      const completedState = {};
      eligibleConnections.forEach((conn) => {
        loadingState[conn.id] = true;
        completedState[conn.id] = false;
      });
      setLoading(loadingState);
      setQuotaCompleted(completedState);

      await Promise.all(
        eligibleConnections.map((conn) => fetchQuota(conn, { force: true })),
      );
      await fetchConnections();

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, fetchConnections, fetchQuota, refreshIntervalMs]);

  // Initial load: fetch connections first so cards render immediately, then fetch quotas
  useEffect(() => {
    const initializeData = async () => {
      setConnectionsLoading(true);
      const conns = await fetchConnections();
      setConnectionsLoading(false);

      const eligibleConnections = conns.filter(isUsageEligible);
      const cachedQuotaData =
        getCachedQuotaDataForConnections(eligibleConnections);
      const cachedIds = new Set(Object.keys(cachedQuotaData));
      const pendingConnections = eligibleConnections.filter(
        (conn) => !cachedIds.has(conn.id),
      );

      const loadingState = {};
      const completedState = {};
      const visible = isPageVisible();
      eligibleConnections.forEach((conn) => {
        loadingState[conn.id] = visible && !cachedIds.has(conn.id);
        completedState[conn.id] = cachedIds.has(conn.id);
      });
      setQuotaData(cachedQuotaData);
      setLoading(loadingState);
      setQuotaCompleted(completedState);

      if (visible) {
        await Promise.all(
          pendingConnections.map((conn) => fetchQuota(conn)),
        );
        if (pendingConnections.length > 0) await fetchConnections();
      }
      setLastUpdated(new Date());
    };

    initializeData();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(refreshIntervalMs));
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(refreshIntervalMs > 0));
    if (!settingsSyncReady) return;

    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotaRefreshIntervalMs: refreshIntervalMs }),
    }).catch(() => {});
  }, [refreshIntervalMs, settingsSyncReady]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      UI_SETTINGS_STORAGE_KEY,
      JSON.stringify({ providerFilter, expiringFirst, collapsedProviders }),
    );
  }, [providerFilter, expiringFirst, collapsedProviders]);

  // Auto-refresh interval
  useEffect(() => {
    clearRefreshTimers();
    if (!refreshIntervalMs || !isPageVisible()) {
      return;
    }

    // Main refresh interval
    intervalRef.current = setInterval(() => {
      refreshAll();
    }, refreshIntervalMs);

    // Countdown interval
    setCountdown(Math.max(1, Math.round(refreshIntervalMs / 1000)));
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return Math.max(1, Math.round(refreshIntervalMs / 1000));
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearRefreshTimers();
    };
  }, [refreshIntervalMs, refreshAll, clearRefreshTimers]);

  // Pause auto-refresh when tab is hidden (Page Visibility API)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearRefreshTimers();
      } else if (refreshIntervalMs) {
        // Resume auto-refresh when tab becomes visible
        clearRefreshTimers();
        intervalRef.current = setInterval(refreshAll, refreshIntervalMs);
        setCountdown(Math.max(1, Math.round(refreshIntervalMs / 1000)));
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (
            prev <= 1 ? Math.max(1, Math.round(refreshIntervalMs / 1000)) : prev - 1
          ));
        }, 1000);
      }
      if (!document.hidden) {
        const missing = connections
          .filter(isUsageEligible)
          .filter((conn) => !quotaData[conn.id] && !loading[conn.id]);
        missing.forEach((conn) => fetchQuota(conn));
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshIntervalMs, refreshAll, clearRefreshTimers, connections, quotaData, loading, fetchQuota]);

  // Filter eligible connections (OAuth + whitelisted apikey)
  const filteredConnections = useMemo(
    () => connections.filter(isUsageEligible),
    [connections],
  );

  const getEarliestResetTime = (conn) => {
    const resetTimes = (quotaData[conn.id]?.quotas || [])
      .map((quota) => quota.resetAt ? new Date(quota.resetAt).getTime() : Number.POSITIVE_INFINITY)
      .filter((time) => Number.isFinite(time));
    return resetTimes.length > 0 ? Math.min(...resetTimes) : Number.POSITIVE_INFINITY;
  };

  // Sort providers by USAGE_SUPPORTED_PROVIDERS order, then alphabetically.
  // Optionally surface accounts with quotas expiring soonest first.
  const providerFilteredConnections = useMemo(
    () => filteredConnections.filter(
      (conn) => providerFilter === "all" || conn.provider === providerFilter,
    ),
    [filteredConnections, providerFilter],
  );

  const sortedConnections = useMemo(
    () => [...providerFilteredConnections].sort((a, b) => {
      if (expiringFirst) {
        const expiryDiff = getEarliestResetTime(a) - getEarliestResetTime(b);
        if (expiryDiff !== 0) return expiryDiff;
      }
      const orderA = USAGE_SUPPORTED_PROVIDERS.indexOf(a.provider);
      const orderB = USAGE_SUPPORTED_PROVIDERS.indexOf(b.provider);
      if (orderA !== orderB) return orderA - orderB;
      return a.provider.localeCompare(b.provider);
    }),
    [providerFilteredConnections, expiringFirst, quotaData],
  );

  // Connection is depleted when any quota entry hit the threshold
  const isConnectionDepleted = (conn) => {
    const quotas = quotaData[conn.id]?.quotas;
    if (!quotas?.length) return false;
    return quotas.some((q) => {
      if (!q.total || q.total <= 0) return false;
      return calculatePercentage(q.used, q.total) <= DEPLETED_QUOTA_THRESHOLD;
    });
  };

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        setConnections((prev) =>
          prev.map((c) => (targetIds.includes(c.id) ? { ...c, isActive } : c)),
        );
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling],
  );

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && !isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };

  const providerOptions = useMemo(
    () => Array.from(new Set(filteredConnections.map((conn) => conn.provider))).sort(
      (a, b) => getProviderSortOrder(a) - getProviderSortOrder(b) || a.localeCompare(b),
    ),
    [filteredConnections],
  );
  const selectedProviderLabel = providerFilter === "all" ? "All providers" : providerFilter;
  const providerAverages = buildProviderQuotaAverages(
    filteredConnections,
    quotaData,
    { loadingById: loading, completedById: quotaCompleted },
  );
  const providerAverageMap = useMemo(
    () => new Map(providerAverages.map((avg) => [avg.provider, avg])),
    [providerAverages],
  );
  const groupedConnections = useMemo(() => {
    const groups = new Map();
    for (const conn of sortedConnections) {
      if (!groups.has(conn.provider)) groups.set(conn.provider, []);
      groups.get(conn.provider).push(conn);
    }
    return Array.from(groups.entries()).sort(
      ([a], [b]) => getProviderSortOrder(a) - getProviderSortOrder(b) || a.localeCompare(b),
    );
  }, [sortedConnections]);

  useEffect(() => {
    if (providerFilter !== "all" && !providerOptions.includes(providerFilter)) {
      setProviderFilter("all");
    }
  }, [providerFilter, providerOptions]);

  // Empty state
  if (!connectionsLoading && sortedConnections.length === 0) {
    return (
      <Card padding="lg">
        <div className="text-center py-12">
          <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
            cloud_off
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">
            No Providers Connected
          </h3>
          <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
            Connect to providers with OAuth to track your API quota limits and
            usage.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <h2 className="text-xl font-semibold text-text-primary">
            Provider Limits
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setProviderMenuOpen((prev) => !prev)}
              className="flex h-8 items-center justify-between gap-1 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
              aria-haspopup="menu"
              aria-expanded={providerMenuOpen}
              title="Filter quota providers"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {providerFilter === "all" ? (
                  <span className="material-symbols-outlined text-[14px] text-text-muted">apps</span>
                ) : (
                  <ProviderIcon
                    src={`/providers/${providerFilter}.png`}
                    alt={providerFilter}
                    size={18}
                    className="size-[18px] rounded object-contain"
                    fallbackText={providerFilter.slice(0, 2).toUpperCase()}
                  />
                )}
                <span className="truncate capitalize hidden lg:inline">{selectedProviderLabel}</span>
              </span>
              <span className="material-symbols-outlined text-[14px] text-text-muted">expand_more</span>
            </button>

            {providerMenuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-30 bg-transparent"
                  aria-label="Close provider filter"
                  onClick={() => setProviderMenuOpen(false)}
                />
                <div className="absolute left-0 z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-black/10 bg-surface/95 p-1.5 shadow-xl shadow-black/10 backdrop-blur dark:border-white/10 dark:bg-surface/95 sm:w-72">
                  <button
                    type="button"
                    onClick={() => { setProviderFilter("all"); setProviderMenuOpen(false); }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === "all" ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                  >
                    <span className="material-symbols-outlined text-[22px]">apps</span>
                    <span className="font-medium">All providers</span>
                    {providerFilter === "all" && <span className="material-symbols-outlined ml-auto text-[20px]">check</span>}
                  </button>
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <div className="max-h-72 overflow-y-auto pr-1">
                    {providerOptions.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => { setProviderFilter(provider); setProviderMenuOpen(false); }}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === provider ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                      >
                        <ProviderIcon
                          src={`/providers/${provider}.png`}
                          alt={provider}
                          size={24}
                          className="size-6 rounded-md object-contain"
                          fallbackText={provider.slice(0, 2).toUpperCase()}
                        />
                        <span className="font-medium capitalize">{provider}</span>
                        {providerFilter === provider && <span className="material-symbols-outlined ml-auto text-[20px]">check</span>}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpiringFirst((prev) => !prev)}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${expiringFirst ? "border-amber-500/40 bg-amber-500/10 text-amber-500" : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"}`}
            title="Sort accounts by earliest quota reset time"
          >
            <span className="material-symbols-outlined text-[14px]">hourglass_top</span>
            <span className="hidden sm:inline">Expiring first</span>
          </button>

          {/* Bulk: disable depleted */}
          <button
            type="button"
            onClick={handleDisableDepleted}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-red-500/30 px-2 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            title="Disable connections with depleted quota (within current filter)"
          >
            <span className="material-symbols-outlined text-[14px]">block</span>
            <span className="hidden sm:inline">Turn off Empty</span>
          </button>

          {/* Bulk: enable available */}
          <button
            type="button"
            onClick={handleEnableAvailable}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 px-2 text-xs text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
            title="Enable connections that still have quota (within current filter)"
          >
            <span className="material-symbols-outlined text-[14px]">check_circle</span>
            <span className="hidden sm:inline">Turn on Available</span>
          </button>

          <button
            type="button"
            onClick={handleQuotaAutoToggle}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${
              quotaAutoToggleEnabled
                ? "border-primary/30 text-primary hover:bg-primary/10"
                : "border-black/10 text-text-muted hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            }`}
            title="Automatically disable exhausted quota accounts and re-enable them when quota restores"
          >
            <span className="material-symbols-outlined text-[14px]">
              {quotaAutoToggleEnabled ? "toggle_on" : "toggle_off"}
            </span>
            <span>Auto toggle</span>
          </button>

          <label className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
            <span
              className={`material-symbols-outlined text-[14px] ${
                refreshIntervalMs ? "text-primary" : "text-text-muted"
              }`}
            >
              schedule
            </span>
            <select
              value={refreshIntervalMs}
              onChange={(event) => setRefreshIntervalMs(Number(event.target.value))}
              className="bg-transparent text-xs focus:outline-none"
              title="Quota refresh interval"
            >
              {REFRESH_INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {refreshIntervalMs > 0 && (
              <span className="text-[10px] text-text-muted tabular-nums">({countdown}s)</span>
            )}
          </label>

          {/* Refresh all button */}
          <button
            type="button"
            onClick={refreshAll}
            disabled={refreshingAll}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 disabled:opacity-50"
            title="Refresh all"
          >
            <span className={`material-symbols-outlined text-[14px] ${refreshingAll ? "animate-spin" : ""}`}>refresh</span>
          </button>
        </div>
      </div>

      {providerAverages.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {providerAverages.map((avg) => {
            const value = avg.averageRemaining;
            const isAvgLoading = avg.isLoading === true;
            const color =
              isAvgLoading ? "bg-transparent" :
              value === null ? "bg-black/10 dark:bg-white/10" :
              value >= 60 ? "bg-green-500" :
              value > 20 ? "bg-yellow-500" :
              "bg-red-500";
            const textColor =
              isAvgLoading ? "text-text-muted" :
              value === null ? "text-text-muted" :
              value >= 60 ? "text-green-600 dark:text-green-400" :
              value > 20 ? "text-yellow-600 dark:text-yellow-400" :
              "text-red-600 dark:text-red-400";

            return (
              <div
                key={avg.provider}
                className="rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <ProviderIcon
                      src={`/providers/${avg.provider}.png`}
                      alt={avg.provider}
                      size={26}
                      className="size-[26px] shrink-0 rounded object-contain"
                      fallbackText={avg.provider.slice(0, 2).toUpperCase()}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium capitalize text-text-primary">
                        {avg.provider}
                      </p>
                      {isAvgLoading ? (
                        <p className="text-[11px] text-text-muted">
                          {avg.activeCount}/{avg.accountCount} active / loading
                        </p>
                      ) : (
                        <p className="text-[11px] text-text-muted">
                          {avg.activeCount}/{avg.accountCount} active
                          {avg.lowCount > 0 ? ` / ${avg.lowCount} low` : ""}
                          {avg.exhaustedCount > 0 ? ` / ${avg.exhaustedCount} empty` : ""}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className={`text-sm font-semibold ${textColor}`}>
                    {isAvgLoading ? (
                      <span className="material-symbols-outlined text-[16px] animate-spin">
                        progress_activity
                      </span>
                    ) : value === null ? "N/A" : `${value}%`}
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                  {isAvgLoading ? (
                    <div className="h-full w-full animate-pulse bg-gradient-to-r from-black/5 via-black/20 to-black/5 dark:from-white/5 dark:via-white/25 dark:to-white/5" />
                  ) : (
                    <div
                      className={`h-full ${color}`}
                      style={{ width: `${value === null ? 0 : Math.min(value, 100)}%` }}
                    />
                  )}
                </div>
                <p className="mt-1 text-[11px] text-text-muted">
                  {isAvgLoading
                    ? `Loading ${avg.pendingCount} quota${avg.pendingCount === 1 ? "" : "s"}`
                    : "Average service quota"}
                </p>
              </div>
            );
          })}
        </div>
      )}

      <div className="-mx-1 overflow-x-auto px-1">
        <div className="flex min-w-max items-center gap-2 pb-1">
          <button
            type="button"
            onClick={() => setProviderFilter("all")}
            className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
              providerFilter === "all"
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">apps</span>
            <span>All providers</span>
          </button>
          {providerOptions.map((provider) => (
            <button
              key={provider}
              type="button"
              onClick={() => setProviderFilter(provider)}
              className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
                providerFilter === provider
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
              }`}
            >
              <ProviderIcon
                src={`/providers/${provider}.png`}
                alt={provider}
                size={22}
                className="size-[22px] rounded object-contain"
                fallbackText={provider.slice(0, 2).toUpperCase()}
              />
              <span className="capitalize">{provider}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {groupedConnections.map(([provider, providerConnections]) => {
          const avg = providerAverageMap.get(provider);
          const avgValue = avg?.averageRemaining ?? null;
          const avgLoading = avg?.isLoading === true;
          const isCollapsed = collapsedProviders[provider] === true;
          const barColor = avgLoading
            ? "bg-transparent"
            : avgValue === null
              ? "bg-black/10 dark:bg-white/10"
              : avgValue >= 60
                ? "bg-green-500"
                : avgValue > 20
                  ? "bg-yellow-500"
                  : "bg-red-500";

          return (
            <section
              key={provider}
              className="rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderIcon
                    src={`/providers/${provider}.png`}
                    alt={provider}
                    size={28}
                    className="size-7 shrink-0 rounded object-contain"
                    fallbackText={provider.slice(0, 2).toUpperCase()}
                  />
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold capitalize text-text-primary">
                      {provider}
                    </h3>
                    <p className="text-[11px] text-text-muted">
                      {providerConnections.length} account{providerConnections.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="w-28">
                    <div className="mb-1 text-right text-xs font-semibold text-text-primary">
                      {avgLoading ? (
                        <span className="material-symbols-outlined text-[14px] animate-spin text-text-muted">
                          progress_activity
                        </span>
                      ) : avgValue === null ? "N/A" : `${avgValue}%`}
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                      {avgLoading ? (
                        <div className="h-full w-full animate-pulse bg-gradient-to-r from-black/5 via-black/20 to-black/5 dark:from-white/5 dark:via-white/25 dark:to-white/5" />
                      ) : (
                        <div
                          className={`h-full ${barColor}`}
                          style={{ width: `${avgValue === null ? 0 : Math.min(avgValue, 100)}%` }}
                        />
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCollapsedProviders((prev) => ({
                      ...prev,
                      [provider]: !prev[provider],
                    }))}
                    className="flex size-8 items-center justify-center rounded-lg border border-black/10 text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:border-white/10 dark:hover:bg-white/5"
                    title={isCollapsed ? "Expand provider" : "Collapse provider"}
                    aria-label={isCollapsed ? "Expand provider" : "Collapse provider"}
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {isCollapsed ? "keyboard_arrow_down" : "keyboard_arrow_up"}
                    </span>
                  </button>
                </div>
              </div>

              {!isCollapsed && (
              <div className="max-h-[34rem] overflow-y-auto pr-1">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {providerConnections.map((conn) => {
          const quota = quotaData[conn.id];
          const isLoading = loading[conn.id];
          const error = errors[conn.id];

          // Use table layout for all providers
          const isInactive = conn.isActive === false;
          const rowBusy = deletingId === conn.id || togglingId === conn.id;

          return (
            <Card
              key={conn.id}
              padding="none"
              className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
            >
              <div className="px-3 py-2 border-b border-black/10 dark:border-white/10">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
                      <ProviderIcon
                        src={`/providers/${conn.provider}.png`}
                        alt={conn.provider}
                        size={32}
                        className="object-contain"
                        fallbackText={
                          conn.provider?.slice(0, 2).toUpperCase() || "PR"
                        }
                      />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-text-primary capitalize truncate">
                        {conn.provider}
                      </h3>
                      {(() => {
                        const isEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
                        const label = isEmail(conn.email) ? conn.email : (isEmail(conn.name) ? conn.name : conn.name);
                        return label ? (
                          <p className="text-xs text-text-muted truncate">{label}</p>
                        ) : null;
                      })()}
                      {conn.quotaAutoDisabled && (
                        <p className="text-[11px] text-red-500 truncate">
                          Auto-disabled until {conn.quotaAutoDisabledUntil ? new Date(conn.quotaAutoDisabledUntil).toLocaleString() : "quota restores"}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => refreshProvider(conn)}
                      disabled={isLoading || rowBusy}
                      className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                      title="Refresh quota"
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] text-text-muted ${isLoading ? "animate-spin" : ""}`}
                      >
                        refresh
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedConnection(conn);
                        setShowEditModal(true);
                      }}
                      disabled={rowBusy}
                      className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
                      title="Edit connection"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        edit
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteConnection(conn.id)}
                      disabled={rowBusy}
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
                      title="Delete connection"
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                      >
                        delete
                      </span>
                    </button>
                    <div
                      className="inline-flex items-center pl-0.5"
                      title={
                        (conn.isActive ?? true)
                          ? "Disable connection"
                          : "Enable connection"
                      }
                    >
                      <Toggle
                        size="sm"
                        checked={conn.isActive ?? true}
                        disabled={rowBusy}
                        onChange={(nextActive) =>
                          handleToggleConnectionActive(conn.id, nextActive)
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-2 py-1.5">
                {isLoading ? (
                  <div className="text-center py-5 text-text-muted">
                    <span className="material-symbols-outlined text-[28px] animate-spin">
                      progress_activity
                    </span>
                  </div>
                ) : error ? (
                  <div className="text-center py-5">
                    <span className="material-symbols-outlined text-[28px] text-red-500">
                      error
                    </span>
                    <p className="mt-1.5 text-xs text-text-muted">{error}</p>
                  </div>
                ) : quota?.message ? (
                  <div className="text-center py-5">
                    <p className="text-xs text-text-muted">{quota.message}</p>
                  </div>
                ) : (
                  <QuotaTable quotas={quota?.quotas} compact />
                )}
              </div>
            </Card>
          );
                  })}
                </div>
              </div>
              )}
            </section>
          );
        })}
      </div>

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
