import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbAdapterForTests } from "../../src/lib/db/driver.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let quota;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quota-auto-"));
  process.env.DATA_DIR = tempDir;
  resetDbAdapterForTests();
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  quota = await import("@/lib/quota/autoDisable.js");
  await db.initDb();
});

afterEach(() => {
  resetDbAdapterForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("provider quota auto-disable", () => {
  it("disables exhausted accounts and stores reset metadata", async () => {
    const conn = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "a@example.com",
      accessToken: "tok",
    });
    const resetAt = new Date(Date.now() + 60_000).toISOString();

    await quota.syncConnectionQuotaState(conn, {
      quotas: {
        daily: { used: 100, total: 100, resetAt },
      },
    });

    const updated = await db.getProviderConnectionById(conn.id);
    expect(updated.isActive).toBe(false);
    expect(updated.quotaAutoDisabled).toBe(true);
    expect(updated.quotaAutoDisabledUntil).toBe(resetAt);
  });

  it("restores only auto-disabled accounts after reset time passes", async () => {
    const auto = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "auto@example.com",
      isActive: false,
    });
    await db.updateProviderConnection(auto.id, {
      quotaAutoDisabled: true,
      quotaAutoDisabledUntil: new Date(Date.now() - 1000).toISOString(),
    });

    const manual = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "manual@example.com",
      isActive: false,
    });

    await quota.restoreExpiredAutoDisabledConnections("codex");

    expect((await db.getProviderConnectionById(auto.id)).isActive).toBe(true);
    expect((await db.getProviderConnectionById(manual.id)).isActive).toBe(false);
  });

  it("does nothing when auto toggle is disabled", async () => {
    await db.updateSettings({ quotaAutoToggleEnabled: false });
    const conn = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "off@example.com",
      accessToken: "tok",
    });

    await quota.syncConnectionQuotaState(conn, {
      quotas: {
        daily: { used: 100, total: 100, resetAt: new Date(Date.now() + 60_000).toISOString() },
      },
    });

    const updated = await db.getProviderConnectionById(conn.id);
    expect(updated.isActive).toBe(true);
    expect(updated.quotaAutoDisabled).toBeUndefined();
  });

  it("calculates average quota by provider service", async () => {
    const { buildProviderQuotaAverages } = await import("@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");
    const connections = [
      { id: "codex-a", provider: "codex", isActive: true },
      { id: "codex-b", provider: "codex", isActive: false },
      { id: "codex-c", provider: "codex", isActive: false },
      { id: "claude-a", provider: "claude", isActive: true },
    ];

    const averages = buildProviderQuotaAverages(connections, {
      "codex-a": {
        quotas: [
          { used: 20, total: 100 },
          { used: 40, total: 100 },
        ],
      },
      "codex-b": {
        quotas: [{ used: 100, total: 100 }],
      },
    });

    expect(averages.find((avg) => avg.provider === "codex")).toMatchObject({
      accountCount: 3,
      activeCount: 1,
      measuredAccounts: 2,
      averageRemaining: 35,
      exhaustedCount: 1,
    });
    expect(averages.find((avg) => avg.provider === "claude")).toMatchObject({
      accountCount: 1,
      activeCount: 1,
      measuredAccounts: 0,
      averageRemaining: null,
    });
  });
});
