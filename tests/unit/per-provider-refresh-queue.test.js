import { describe, expect, it } from "vitest";
import {
  runPerProviderRefreshQueue,
  runQuotaRefreshQueue,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaRefreshQueue.js";
import { parseQuotaData, parseQuotaMetadata } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runPerProviderRefreshQueue", () => {
  it("processes each provider's connections sequentially while providers run in parallel", async () => {
    const started = [];
    const release = new Map();

    const items = [
      { id: "a1", provider: "antigravity" },
      { id: "a2", provider: "antigravity" },
      { id: "c1", provider: "claude" },
    ];

    const queue = runPerProviderRefreshQueue(
      items,
      (item) =>
        new Promise((resolve) => {
          started.push(item.id);
          release.set(item.id, resolve);
        }),
    );

    await tick();
    // First item of each provider group starts in parallel; a2 waits on a1.
    expect(started.sort()).toEqual(["a1", "c1"]);

    release.get("a1")();
    await tick();
    expect(started.sort()).toEqual(["a1", "a2", "c1"]);

    release.get("a2")();
    release.get("c1")();
    await expect(queue.done).resolves.toMatchObject({ total: 3 });
  });

  it("reports settle order and tolerates worker errors", async () => {
    const settled = [];
    const errors = [];

    const items = [
      { id: "x", provider: "p1" },
      { id: "y", provider: "p1" },
    ];

    const queue = runPerProviderRefreshQueue(items, (item) => {
      if (item.id === "x") return Promise.reject(new Error("boom"));
      return Promise.resolve();
    }, {
      onItemSettled: (item) => settled.push(item.id),
      onError: (error, item) => errors.push([item.id, error.message]),
    });

    await expect(queue.done).resolves.toMatchObject({ total: 2 });
    expect(settled).toEqual(["x", "y"]);
    expect(errors).toEqual([["x", "boom"]]);
  });

  it("cancels remaining connections within a provider group", async () => {
    const started = [];
    let releaseFirst;

    const items = [
      { id: "1", provider: "p" },
      { id: "2", provider: "p" },
      { id: "3", provider: "p" },
    ];

    const queue = runPerProviderRefreshQueue(
      items,
      (item) =>
        new Promise((resolve) => {
          started.push(item.id);
          if (item.id === "1") releaseFirst = resolve;
        }),
    );

    await tick();
    queue.cancel();
    releaseFirst();

    await expect(queue.done).resolves.toMatchObject({ cancelled: true });
    expect(started).toEqual(["1"]);
  });

  it("keeps runQuotaRefreshQueue exported for back-compat", () => {
    expect(typeof runQuotaRefreshQueue).toBe("function");
  });
});

describe("parseQuotaData antigravity grouping", () => {
  it("carries family and window tags through to the normalized quotas", () => {
    const parsed = parseQuotaData("antigravity", {
      quotas: {
        "gemini-3-flash": {
          displayName: "Gemini 3 Flash",
          used: 100,
          total: 1000,
          resetAt: "2026-01-01T00:00:00Z",
          remainingPercentage: 90,
          family: "gemini",
          window: "weekly",
        },
        "claude-sonnet-4-6": {
          displayName: "Claude Sonnet",
          used: 500,
          total: 1000,
          resetAt: "2026-01-01T05:00:00Z",
          remainingPercentage: 50,
          family: "claude_gpt",
          window: "five_hour",
        },
      },
    });

    expect(parsed).toHaveLength(2);
    const gemini = parsed.find((q) => q.modelKey === "gemini-3-flash");
    const claude = parsed.find((q) => q.modelKey === "claude-sonnet-4-6");
    expect(gemini).toMatchObject({ family: "gemini", window: "weekly" });
    expect(claude).toMatchObject({ family: "claude_gpt", window: "five_hour" });
  });

  it("defaults family/window to null when absent", () => {
    const parsed = parseQuotaData("antigravity", {
      quotas: { "x": { used: 0, total: 1000 } },
    });
    expect(parsed[0]).toMatchObject({ family: null, window: null });
  });

  it("marks paid Antigravity accounts as session-capable and exposes AI credits", () => {
    const data = {
      subscriptionInfo: {
        paidTier: {
          id: "g1-pro-tier",
          availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "113", minimumCreditAmountForUsage: "50" }],
        },
      },
      quotas: {
        "gemini-3-flash": {
          displayName: "Gemini 3 Flash",
          used: 30,
          total: 1000,
          remainingPercentage: 97,
          family: "gemini",
          window: "weekly",
        },
      },
    };

    expect(parseQuotaMetadata("antigravity", data)).toMatchObject({
      supportsSessionQuota: true,
      aiCredits: { amount: 113, minimumForUsage: 50, type: "GOOGLE_ONE_AI" },
    });
    expect(parseQuotaData("antigravity", data)[0]).toMatchObject({
      remainingPercentage: 97,
      supportsSessionQuota: true,
    });
  });

  it("does not synthesize session support for free weekly-only Antigravity accounts", () => {
    const data = {
      subscriptionInfo: {
        currentTier: { id: "free-tier" },
        paidTier: { id: "free-tier", availableCredits: [{ creditType: "GOOGLE_ONE_AI", minimumCreditAmountForUsage: "50" }] },
      },
      quotas: {
        "claude-sonnet-4-6": {
          used: 0,
          total: 1000,
          remainingPercentage: 100,
          family: "claude_gpt",
          window: "weekly",
        },
      },
    };

    expect(parseQuotaMetadata("antigravity", data)).toEqual({ supportsSessionQuota: false });
    expect(parseQuotaData("antigravity", data)[0]).toMatchObject({ supportsSessionQuota: false });
  });
});
