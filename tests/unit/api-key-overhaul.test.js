import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbAdapterForTests } from "../../src/lib/db/driver.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-apikey-overhaul-"));
  process.env.DATA_DIR = tempDir;
  resetDbAdapterForTests();
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  resetDbAdapterForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function use(key, total, opts = {}) {
  await db.saveRequestUsage({
    provider: "openai",
    model: "gpt-4",
    apiKey: key,
    tokens: { prompt_tokens: total, completion_tokens: 0 },
    ...opts,
  });
}

describe("API key overhaul — fusion limits", () => {
  it("blocks when any active timed limit is exhausted (daily+weekly fusion)", async () => {
    const key = await db.createApiKey("fusion", "m", { config: { limits: { daily: 100, weekly: 250 } } });
    await use(key.key, 110);
    const access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(false);
    expect(access.usage.limits.daily.exhausted).toBe(true);
    expect(access.usage.limits.weekly.exhausted).toBe(false);
  });

  it("enforces a monthly limit", async () => {
    const key = await db.createApiKey("monthly", "m", { config: { limits: { monthly: 100 } } });
    await use(key.key, 120);
    const access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(false);
    expect(access.usage.limits.monthly.exhausted).toBe(true);
  });
});

describe("API key overhaul — hard cap from anchor", () => {
  it("only counts usage logged after the hard cap was set", async () => {
    const key = await db.createApiKey("hardanchor", "m");
    // Pre-existing usage well before the cap is applied.
    await use(key.key, 500, { timestamp: new Date(Date.now() - 3600_000).toISOString() });
    // Apply hard cap now (anchor = now).
    await db.updateApiKey(key.id, { config: { limits: { hard: 100 } } });

    let access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(true); // pre-anchor usage does not count

    await use(key.key, 110);
    access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(false);
    expect(access.usage.limits.hard.exhausted).toBe(true);
  });
});

describe("API key overhaul — overage pool", () => {
  it("permits usage above the daily limit via overage, tagged separately", async () => {
    const key = await db.createApiKey("ov", "m", {
      config: { limits: { daily: 100 }, overage: { enabled: true, limit: 50 } },
    });
    await use(key.key, 100); // exhaust daily (tagged normal)
    let access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(true); // overage covers
    expect(access.consumeOverage).toBe(true);

    await use(key.key, 30); // consumed from overage (tagged overage)
    const summary = await db.getApiKeyUsageSummary(key.key);
    expect(summary.overage.used).toBe(30);
    expect(summary.overage.remaining).toBe(20);
    expect(summary.limits.daily.used).toBe(100); // overage does not inflate daily

    await use(key.key, 30); // overage now 60 >= 50
    access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(false);
    expect(access.usage.overage.exhausted).toBe(true);
  });

  it("reset overage re-anchors and clears overage usage only", async () => {
    const key = await db.createApiKey("ovr", "m", {
      config: { limits: { daily: 100 }, overage: { enabled: true, limit: 50 } },
    });
    await use(key.key, 100);
    await use(key.key, 40); // overage
    let summary = await db.getApiKeyUsageSummary(key.key);
    expect(summary.overage.used).toBe(40);

    await db.resetApiKeyUsage(key.id, "overage");
    summary = await db.getApiKeyUsageSummary(key.key);
    expect(summary.overage.used).toBe(0);
    expect(summary.limits.daily.used).toBe(100); // normal usage untouched
  });

  it("blocks overage once its window has ended", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const key = await db.createApiKey("ovwin", "m", {
      config: {
        limits: { daily: 100 },
        overage: { enabled: true, limit: 50, window: { availableUntil: past } },
      },
    });
    await use(key.key, 100);
    const access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(false); // overage window expired
  });
});

describe("API key overhaul — timers", () => {
  it("rejects outside the daily authorized hours window", async () => {
    const h = new Date().getHours();
    const start = String((h + 2) % 24).padStart(2, "0") + ":00";
    const end = String((h + 3) % 24).padStart(2, "0") + ":00";
    const key = await db.createApiKey("hours", "m", { config: { dailyWindow: { start, end } } });
    const access = await db.checkApiKeyAccess(key.key);
    expect(access.valid).toBe(false);
    expect(access.reason).toBe("outside_authorized_hours");
  });

  it("rejects before availableFrom and after availableUntil", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const notYet = await db.createApiKey("future", "m", { config: { availability: { availableFrom: future } } });
    expect((await db.checkApiKeyAccess(notYet.key)).reason).toBe("not_yet_available");

    const past = new Date(Date.now() - 3600_000).toISOString();
    const ended = await db.createApiKey("ended", "m", { config: { availability: { availableUntil: past } } });
    expect((await db.checkApiKeyAccess(ended.key)).status).toBe("expired");
  });
});