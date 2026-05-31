import { describe, it, expect, vi, beforeEach } from "vitest";

const getAccessToken = vi.fn();

vi.mock("open-sse/services/tokenRefresh.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getAccessToken: (...args) => getAccessToken(...args) };
});

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
  invalidateProjectId: vi.fn(),
  removeConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  updateProviderConnection: vi.fn(async () => true),
}));

vi.mock("@/sse/services/codexOAuthRefresh.js", () => ({
  refreshCodexConnectionIfDue: vi.fn(async () => null),
}));

const expiredIso = () => new Date(Date.now() - 60_000).toISOString();

describe("tokenRefresh per-connection lease", () => {
  beforeEach(() => {
    getAccessToken.mockReset();
    getAccessToken.mockImplementation(
      () => new Promise((res) => setTimeout(
        () => res({ accessToken: "new-access", refreshToken: "r2", expiresIn: 3600 }), 25,
      )),
    );
  });

  it("dedupes concurrent refreshes for the same connection", async () => {
    const mod = await import("../../src/sse/services/tokenRefresh.js");
    const creds = { connectionId: "conn-A", accessToken: "old", refreshToken: "r1", expiresAt: expiredIso() };

    const [a, b] = await Promise.all([
      mod.checkAndRefreshToken("claude", { ...creds }),
      mod.checkAndRefreshToken("claude", { ...creds }),
    ]);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("new-access");
    expect(b.accessToken).toBe("new-access");
  });

  it("does not dedupe across different connections", async () => {
    const mod = await import("../../src/sse/services/tokenRefresh.js");
    const base = { accessToken: "old", refreshToken: "r1", expiresAt: expiredIso() };

    await Promise.all([
      mod.checkAndRefreshToken("claude", { ...base, connectionId: "conn-B" }),
      mod.checkAndRefreshToken("claude", { ...base, connectionId: "conn-C" }),
    ]);

    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("releases the lease after settle so a later refresh runs again", async () => {
    const mod = await import("../../src/sse/services/tokenRefresh.js");
    const creds = { connectionId: "conn-D", accessToken: "old", refreshToken: "r1", expiresAt: expiredIso() };

    await mod.checkAndRefreshToken("claude", { ...creds });
    await mod.checkAndRefreshToken("claude", { ...creds });

    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
});