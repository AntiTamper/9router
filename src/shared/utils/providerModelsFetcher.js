// Fetch and cache suggested models for providers that expose a public models API
// Fetches via backend proxy to avoid CORS issues

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 64;
const cache = new Map(); // key: fetcher.url → { data, expiresAt }

function pruneCache(now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || now >= entry.expiresAt) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

/**
 * Fetch suggested models for a provider using its modelsFetcher config.
 * Results are cached in-memory for CACHE_TTL_MS.
 * @param {{ url: string, type: string }} fetcher
 * @returns {Promise<Array<{ id: string, name: string, contextLength?: number }>>}
 */
export async function fetchSuggestedModels(fetcher) {
  if (!fetcher?.url || !fetcher?.type) return [];

  const now = Date.now();
  pruneCache(now);

  const cached = cache.get(fetcher.url);
  if (cached && now < cached.expiresAt) {
    cache.delete(fetcher.url);
    cache.set(fetcher.url, cached);
    return cached.data;
  }

  try {
    const params = new URLSearchParams({ url: fetcher.url, type: fetcher.type });
    const res = await fetch(`/api/providers/suggested-models?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    const data = json.data ?? [];
    cache.set(fetcher.url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    pruneCache();
    return data;
  } catch {
    return [];
  }
}
