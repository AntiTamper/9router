import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  statsEmitter: {
    on: vi.fn(),
    off: vi.fn(),
  },
  getUsageStats: vi.fn(async () => ({
    activeRequests: [],
    recentRequests: [],
    errorProvider: {},
  })),
  getActiveRequests: vi.fn(async () => ({
    activeRequests: [],
    recentRequests: [],
    errorProvider: {},
  })),
}));

vi.mock("@/lib/usageDb", () => mocks);

describe("/api/usage/stream cleanup", () => {
  beforeEach(() => {
    mocks.statsEmitter.on.mockClear();
    mocks.statsEmitter.off.mockClear();
    mocks.getUsageStats.mockClear();
    mocks.getActiveRequests.mockClear();
  });

  it("removes stats listeners when the request aborts", async () => {
    const { GET } = await import("../../src/app/api/usage/stream/route.js");
    const abort = new AbortController();
    const res = await GET(new Request("http://localhost/api/usage/stream", { signal: abort.signal }));
    const reader = res.body.getReader();

    await reader.read();
    expect(mocks.statsEmitter.on).toHaveBeenCalledWith("update", expect.any(Function));
    expect(mocks.statsEmitter.on).toHaveBeenCalledWith("pending", expect.any(Function));

    abort.abort();
    await Promise.resolve();

    expect(mocks.statsEmitter.off).toHaveBeenCalledWith("update", expect.any(Function));
    expect(mocks.statsEmitter.off).toHaveBeenCalledWith("pending", expect.any(Function));

    await reader.cancel();
  });
});
