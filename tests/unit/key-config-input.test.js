import { describe, it, expect } from "vitest";
import { parseStructuredConfig, parseKeyTimers } from "@/app/api/keys/keyConfigInput.js";

describe("parseStructuredConfig", () => {
  it("accepts fusion limits (daily+weekly+monthly)", () => {
    const { config, error } = parseStructuredConfig({
      limits: { daily: 1000, weekly: 5000, monthly: 20000, hard: null },
    });
    expect(error).toBeUndefined();
    expect(config.limits).toEqual({ daily: 1000, weekly: 5000, monthly: 20000, hard: null });
  });

  it("rejects a non-positive limit", () => {
    const { error } = parseStructuredConfig({ limits: { daily: 0 } });
    expect(error).toMatch(/daily limit/i);
  });

  it("validates a daily authorized-hours window", () => {
    const ok = parseStructuredConfig({ dailyWindow: { start: "09:00", end: "17:00" } });
    expect(ok.error).toBeUndefined();
    expect(ok.config.dailyWindow).toEqual({ start: "09:00", end: "17:00" });
    const bad = parseStructuredConfig({ dailyWindow: { start: "9am", end: "17:00" } });
    expect(bad.error).toMatch(/daily window/i);
  });

  it("normalizes an availability window to ISO", () => {
    const { config } = parseStructuredConfig({
      availability: { availableFrom: "2026-01-01T00:00:00Z", availableUntil: "2026-02-01T00:00:00Z" },
    });
    expect(config.availability.availableFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(config.availability.availableUntil).toBe("2026-02-01T00:00:00.000Z");
  });

  it("requires a combo name for combo exposure", () => {
    expect(parseStructuredConfig({ exposure: { mode: "combo", combo: "" } }).error).toMatch(/combo/i);
    expect(parseStructuredConfig({ exposure: { mode: "combo", combo: "fast" } }).config.exposure)
      .toEqual({ mode: "combo", combo: "fast" });
    expect(parseStructuredConfig({ exposure: { mode: "all" } }).config.exposure)
      .toEqual({ mode: "all", combo: null });
  });

  it("builds a per-key token saver", () => {
    const { config } = parseStructuredConfig({
      tokenSaver: { rtk: true, toon: false, caveman: true, cavemanLevel: "ultra", codexUsage: false },
    });
    expect(config.tokenSaver).toEqual({ rtk: true, toon: false, caveman: true, cavemanLevel: "ultra", codexUsage: false });
  });

  it("rejects an invalid caveman level", () => {
    expect(parseStructuredConfig({ tokenSaver: { cavemanLevel: "nope" } }).error).toMatch(/cavemanLevel/i);
  });

  it("validates the overage pool", () => {
    expect(parseStructuredConfig({ overage: { enabled: true } }).error).toMatch(/overage/i);
    const { config } = parseStructuredConfig({ overage: { enabled: true, limit: 1000 } });
    expect(config.overage).toEqual({ enabled: true, limit: 1000, window: null });
    expect(parseStructuredConfig({ overage: { enabled: false } }).config.overage).toBeNull();
  });
});

describe("parseKeyTimers", () => {
  it("accepts expire-after duration", () => {
    const { options } = parseKeyTimers({ expiresInMs: 3600000 });
    expect(options.expiresInMs).toBe(3600000);
  });

  it("clears expiry when expiresInMs is empty", () => {
    const { options } = parseKeyTimers({ expiresInMs: "" });
    expect(options.expiresAt).toBeNull();
  });

  it("normalizes expiresAt to ISO", () => {
    const { options } = parseKeyTimers({ expiresAt: "2026-03-01T00:00:00Z" });
    expect(options.expiresAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("rejects an invalid expiry date", () => {
    expect(parseKeyTimers({ expiresAt: "not-a-date" }).error).toMatch(/expiry/i);
  });

  it("reads the delete-if-expired flag", () => {
    expect(parseKeyTimers({ autoDeleteExpired: false }).options.autoDeleteExpired).toBe(false);
    expect(parseKeyTimers({ autoDeleteExpired: true }).options.autoDeleteExpired).toBe(true);
  });
});