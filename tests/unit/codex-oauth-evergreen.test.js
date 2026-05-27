import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalFetch = global.fetch;
let tempDir;

async function loadFresh() {
  vi.resetModules();
  delete global.__codexOAuthEvergreen;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  const service = await import("@/sse/services/codexOAuthRefresh.js");
  return { db, service };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function tokenResponse(accessToken = "access-new", refreshToken = "refresh-new") {
  return new Response(JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-evergreen-"));
  process.env.DATA_DIR = tempDir;
  global.fetch = vi.fn();
});

afterEach(async () => {
  try {
    const { resetDbAdapterForTests } = await import("@/lib/db/driver.js");
    resetDbAdapterForTests();
  } catch {}
  global.fetch = originalFetch;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete global.__codexOAuthEvergreen;
});

describe("Codex OAuth evergreen", () => {
  it("selects expired, near-expiry, and stale keepalive rows only", async () => {
    const now = Date.now();
    const { db, service } = await loadFresh();
    const mk = (email, data) => db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email,
      accessToken: `access-${email}`,
      refreshToken: `refresh-${email}`,
      providerSpecificData: { evergreen: true },
      ...data,
    });
    const expired = await mk("expired@test.local", { expiresAt: iso(now - 1000) });
    const near = await mk("near@test.local", { expiresAt: iso(now + 23 * 60 * 60 * 1000) });
    const stale = await mk("stale@test.local", { expiresAt: iso(now + 7 * 24 * 60 * 60 * 1000), lastSuccessfulRefreshAt: iso(now - 73 * 60 * 60 * 1000) });
    await mk("fresh@test.local", { expiresAt: iso(now + 7 * 24 * 60 * 60 * 1000), lastSuccessfulRefreshAt: iso(now) });
    await mk("reauth@test.local", { expiresAt: iso(now - 1000), providerSpecificData: { evergreen: true, reauthRequired: true } });
    await db.createProviderConnection({ provider: "codex", authType: "access_token", name: "raw", accessToken: "raw", refreshToken: "rt", providerSpecificData: { evergreen: false } });
    await db.createProviderConnection({ provider: "claude", authType: "oauth", email: "c@test.local", refreshToken: "rt", expiresAt: iso(now - 1000) });

    const candidates = await service.getCodexOAuthRefreshCandidates(await db.getSettings(), now);
    expect(candidates.map((c) => c.id).sort()).toEqual([expired.id, near.id, stale.id].sort());
  });

  it("deduplicates concurrent refresh for one connection and persists rotated token", async () => {
    const now = Date.now();
    const { db, service } = await loadFresh();
    const conn = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "dedupe@test.local",
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: iso(now - 1000),
      providerSpecificData: { evergreen: true },
    });
    const fetchFn = vi.fn().mockResolvedValue(tokenResponse("access-rotated", "refresh-rotated"));

    const [a, b] = await Promise.all([
      service.safeRefreshCodexConnection(conn.id, { force: true, fetchFn }),
      service.safeRefreshCodexConnection(conn.id, { force: true, fetchFn }),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("access-rotated");
    expect(b.accessToken).toBe("access-rotated");
    const updated = await db.getProviderConnectionById(conn.id);
    expect(updated.refreshToken).toBe("refresh-rotated");
    expect(updated.lastSuccessfulRefreshAt).toBeTruthy();
    expect(updated.refreshLeaseId).toBeNull();
  });

  it("marks unrecoverable refresh as inactive with reauth metadata", async () => {
    const { db, service } = await loadFresh();
    const conn = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "bad@test.local",
      accessToken: "access-old",
      refreshToken: "refresh-bad",
      expiresAt: iso(Date.now() - 1000),
      providerSpecificData: { evergreen: true },
    });
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    const result = await service.safeRefreshCodexConnection(conn.id, { force: true, fetchFn });

    expect(result.reauthRequired).toBe(true);
    const updated = await db.getProviderConnectionById(conn.id);
    expect(updated.isActive).toBe(false);
    expect(updated.testStatus).toBe("error");
    expect(updated.providerSpecificData.reauthRequired).toBe(true);
  });

  it("reactive Codex executor refreshes a future-expiry invalid access token once", async () => {
    const { db } = await loadFresh();
    const conn = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "future@test.local",
      accessToken: "access-invalid",
      refreshToken: "refresh-valid",
      expiresAt: iso(Date.now() + 7 * 24 * 60 * 60 * 1000),
      providerSpecificData: { evergreen: true },
    });
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("access-fixed", "refresh-fixed"));
    global.fetch = fetchMock;
    const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
    const executor = new CodexExecutor();

    const result = await executor.refreshCredentials({ connectionId: conn.id, refreshToken: "refresh-valid" }, console);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("access-fixed");
    expect((await db.getProviderConnectionById(conn.id)).refreshToken).toBe("refresh-fixed");
  });

  it("counts active refresh leases for deploy drain", async () => {
    const { db } = await loadFresh();
    const active = await db.createProviderConnection({ provider: "codex", authType: "oauth", email: "lease@test.local", refreshToken: "rt", providerSpecificData: { evergreen: true } });
    await db.createProviderConnection({ provider: "codex", authType: "oauth", email: "oldlease@test.local", refreshToken: "rt2", refreshLeaseId: "old", refreshLeaseUntil: iso(Date.now() - 1000), providerSpecificData: { evergreen: true } });
    await db.acquireProviderConnectionRefreshLease(active.id, { leaseId: "live", leaseMs: 60_000 });

    expect(await db.getActiveCodexRefreshLeaseCount()).toBe(1);
  });
});
