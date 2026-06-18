import { describe, expect, it } from "vitest";
import { runQuotaRefreshQueue } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaRefreshQueue.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("quota refresh queue", () => {
  it("runs quota refreshes concurrently instead of one by one", async () => {
    const started = [];
    const release = new Map();

    const queue = runQuotaRefreshQueue(
      ["a", "b", "c"],
      (item) => new Promise((resolve) => {
        started.push(item);
        release.set(item, resolve);
      }),
      { concurrency: 2 },
    );

    await tick();
    expect(started).toEqual(["a", "b"]);

    release.get("a")();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);

    release.get("b")();
    release.get("c")();
    await expect(queue.done).resolves.toMatchObject({ settled: 3, total: 3 });
  });

  it("lets fast quota refreshes finish while a slow provider is still pending", async () => {
    const started = [];
    const settled = [];
    let releaseSlow;

    const queue = runQuotaRefreshQueue(
      ["slow", "fast"],
      (item) => {
        started.push(item);
        if (item === "slow") {
          return new Promise((resolve) => {
            releaseSlow = resolve;
          });
        }
        return Promise.resolve();
      },
      {
        concurrency: 2,
        onItemSettled: (item) => settled.push(item),
      },
    );

    await tick();
    await tick();
    expect(started).toEqual(["slow", "fast"]);
    expect(settled).toEqual(["fast"]);

    releaseSlow();
    await expect(queue.done).resolves.toMatchObject({ settled: 2, total: 2 });
    expect(settled).toEqual(["fast", "slow"]);
  });

  it("cancels queued quota refreshes without starting remaining providers", async () => {
    const started = [];
    let releaseFirst;

    const queue = runQuotaRefreshQueue(
      [1, 2, 3],
      (item) => new Promise((resolve) => {
        started.push(item);
        if (item === 1) releaseFirst = resolve;
      }),
      { concurrency: 1 },
    );

    await tick();
    queue.cancel();
    releaseFirst();

    await expect(queue.done).resolves.toMatchObject({ cancelled: true });
    expect(started).toEqual([1]);
  });
});
