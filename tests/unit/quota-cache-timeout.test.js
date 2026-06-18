import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchQuotaWithCache,
  mergeQuotaCacheEntries,
  removeQuotaCacheEntries,
  PROVIDER_QUOTA_FETCH_TIMEOUT_MS,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaCache.js";

describe("quota cache timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    removeQuotaCacheEntries(["timeout-conn"]);
  });

  it("returns stale quota data when refresh times out", async () => {
    vi.useFakeTimers();
    mergeQuotaCacheEntries({
      "timeout-conn": { quotas: [{ name: "session", used: 1, total: 10 }], savedAt: Date.now() - 60 * 60 * 1000 },
    });

    vi.stubGlobal("fetch", vi.fn((_url, options = {}) => new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })));

    const pending = fetchQuotaWithCache({ id: "timeout-conn", provider: "codex" }, { force: true });
    await vi.advanceTimersByTimeAsync(PROVIDER_QUOTA_FETCH_TIMEOUT_MS + 1);

    await expect(pending).resolves.toMatchObject({
      fromCache: true,
      stale: true,
      entry: { quotas: [{ name: "session", used: 1, total: 10 }] },
    });
  });
});
