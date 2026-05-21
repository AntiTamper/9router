// Kimi model catalog fetcher.
//
// Calls Kimi For Coding (`api.kimi.com/coding/v1/models`) and the public
// Moonshot APIs (`api.moonshot.ai`, `api.moonshot.cn`) to discover the live
// per-account context window for each model. Plays the same role as
// `kiroModels.js` does for AWS CodeWhisperer: result is cached per credential
// for a short TTL and any failure returns null so the caller can fall back to
// the static `PROVIDER_MODELS` table without breaking dashboards or
// `/v1/models`.
//
// Returned shape (per model):
//   { id, upstreamModelId, contextWindow, maxOutputTokens?, raw }
//
// `contextWindow` is the upstream's authoritative limit (e.g. 262144 for the
// live Kimi K2.6). When the upstream omits it the entry is still returned
// with a null contextWindow so the static fallback applies.

import { createHash } from "crypto";
import { PROVIDERS } from "../config/providers.js";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;

/** @type {Map<string, { expiresAt: number, models: any[], rawModels: any[] }>} */
const catalogCache = new Map();

function pruneCatalogCache(now) {
  if (catalogCache.size <= CACHE_MAX_ENTRIES) return;
  const expired = [];
  for (const [k, v] of catalogCache) {
    if (v.expiresAt <= now) expired.push(k);
  }
  for (const k of expired) catalogCache.delete(k);
  if (catalogCache.size <= CACHE_MAX_ENTRIES) return;
  const entries = [...catalogCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (let i = 0; i < entries.length && catalogCache.size > CACHE_MAX_ENTRIES; i++) {
    catalogCache.delete(entries[i][0]);
  }
}

function cacheKey(provider, credentials) {
  const seed = credentials?.apiKey || credentials?.accessToken || "anonymous";
  return createHash("sha256").update(`${provider}:${seed}`).digest("hex");
}

function pickContextWindow(entry) {
  const candidates = [
    entry?.context_length,
    entry?.context_window,
    entry?.contextWindow,
    entry?.max_input_tokens,
    entry?.maxInputTokens,
    entry?.max_context_length,
    entry?.tokenLimits?.maxInputTokens,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

function pickMaxOutputTokens(entry) {
  const candidates = [
    entry?.max_output_tokens,
    entry?.maxOutputTokens,
    entry?.completion_tokens,
    entry?.tokenLimits?.maxOutputTokens,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

function normalizeRawModels(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.models)) return raw.models;
  if (Array.isArray(raw.results)) return raw.results;
  return [];
}

async function fetchOnce(url, token, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  // Compose timeout + caller signal cleanly. Listeners are removed in finally
  // so a long-lived parent signal does not accumulate per-call listeners.
  let onParentAbort = null;
  if (signal) {
    if (signal.aborted) {
      ctrl.abort();
    } else {
      onParentAbort = () => ctrl.abort();
      signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
    if (signal && onParentAbort) {
      signal.removeEventListener("abort", onParentAbort);
    }
  }
}

function urlsForProvider(providerKey) {
  const cfg = PROVIDERS[providerKey];
  if (!cfg) return [];
  if (Array.isArray(cfg.modelsUrls) && cfg.modelsUrls.length) return cfg.modelsUrls;
  if (typeof cfg.modelsUrl === "string" && cfg.modelsUrl) return [cfg.modelsUrl];
  return [];
}

/**
 * Resolve the live Kimi model catalog for a credential. Tries every URL
 * configured on the provider in order, returns on first success. Failure on
 * all URLs returns null. Token can be `apiKey` (Moonshot) or `accessToken`
 * (Kimi For Coding session token).
 */
export async function resolveKimiModels(providerKey, credentials, options = {}) {
  if (!credentials) return null;
  const token = credentials.apiKey || credentials.accessToken;
  if (!token) return null;
  const urls = urlsForProvider(providerKey);
  if (!urls.length) return null;

  const key = cacheKey(providerKey, credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) return { models: cached.models, rawModels: cached.rawModels };
  }

  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetchOnce(url, token, options.signal);
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      const rawModels = normalizeRawModels(data);
      const models = rawModels
        .map((m) => {
          const id = m?.id || m?.name || m?.model;
          if (!id) return null;
          return {
            id,
            upstreamModelId: id,
            contextWindow: pickContextWindow(m),
            maxOutputTokens: pickMaxOutputTokens(m),
            raw: m,
          };
        })
        .filter(Boolean);
      catalogCache.set(key, { expiresAt: now + CACHE_TTL_MS, models, rawModels });
      pruneCatalogCache(now);
      return { models, rawModels };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      lastErr = err?.message || String(err);
    }
  }
  options.log?.warn?.("KIMI_MODELS", `live catalog fetch failed: ${lastErr}`);
  return null;
}

/**
 * Drop the cache entry for a credential (used when an upstream 400
 * "token limit" error makes the cached value stale).
 */
export function invalidateKimiCatalog(providerKey, credentials) {
  if (!credentials) return;
  const key = cacheKey(providerKey, credentials);
  catalogCache.delete(key);
}

export function clearKimiCatalogCache() {
  catalogCache.clear();
}