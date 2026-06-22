import { describe, expect, it } from "vitest";
import { buildGroups, remainingOf } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaGroups.js";

describe("quotaGroups", () => {
  it("buildGroups aggregates all/gemini/claude_gpt by window", () => {
    const quotas = [
      { family: "all", window: "weekly", remainingPercentage: 80, resetAt: "2026-06-27T00:00:00Z" },
      { family: "gemini", window: "weekly", remainingPercentage: 60, resetAt: "2026-06-27T00:00:00Z" },
      { family: "gemini", window: "five_hour", remainingPercentage: 90, resetAt: "2026-06-20T09:00:00Z" },
      { family: "claude_gpt", window: "weekly", remainingPercentage: 70, resetAt: "2026-06-27T00:00:00Z" },
      { family: "claude_gpt", window: "five_hour", remainingPercentage: 85, resetAt: "2026-06-20T09:00:00Z" },
    ];
    const groups = buildGroups(quotas);
    expect(groups.has("all")).toBe(true);
    expect(groups.has("gemini")).toBe(true);
    expect(groups.has("claude_gpt")).toBe(true);
    expect(groups.get("all").get("weekly").remaining).toBe(80);
    expect(groups.get("gemini").get("weekly").remaining).toBe(60);
    expect(groups.get("gemini").get("five_hour").remaining).toBe(90);
    expect(groups.get("claude_gpt").get("weekly").remaining).toBe(70);
    expect(groups.get("claude_gpt").get("five_hour").remaining).toBe(85);
  });

  it("buildGroups picks worst-case (lowest remaining) and earliest reset on repeats", () => {
    const quotas = [
      { family: "gemini", window: "weekly", remainingPercentage: 80, resetAt: "2026-06-27T00:00:00Z" },
      { family: "gemini", window: "weekly", remainingPercentage: 40, resetAt: "2026-06-26T00:00:00Z" },
    ];
    const groups = buildGroups(quotas);
    const g = groups.get("gemini").get("weekly");
    expect(g.remaining).toBe(40);
    expect(g.resetAt).toBe("2026-06-26T00:00:00Z");
  });

  it("buildGroups does not fabricate missing windows", () => {
    const quotas = [
      { family: "gemini", window: "weekly", remainingPercentage: 60, resetAt: "2026-06-27T00:00:00Z" },
    ];
    const groups = buildGroups(quotas);
    expect(groups.get("gemini").has("weekly")).toBe(true);
    expect(groups.get("gemini").has("five_hour")).toBe(false);
  });

  it("buildGroups infers family from modelKey when family missing", () => {
    const quotas = [
      { modelKey: "gemini:weekly", window: "weekly", remainingPercentage: 60, resetAt: "2026-06-27T00:00:00Z" },
      { modelKey: "all:weekly", window: "weekly", remainingPercentage: 90, resetAt: "2026-06-27T00:00:00Z" },
      { modelKey: "claude_gpt:weekly", window: "weekly", remainingPercentage: 70, resetAt: "2026-06-27T00:00:00Z" },
    ];
    const groups = buildGroups(quotas);
    expect(groups.get("gemini").get("weekly").remaining).toBe(60);
    expect(groups.get("all").get("weekly").remaining).toBe(90);
    expect(groups.get("claude_gpt").get("weekly").remaining).toBe(70);
  });

  it("remainingOf falls back to used/total when remainingPercentage missing", () => {
    expect(remainingOf({ remainingPercentage: 75 })).toBe(75);
    expect(remainingOf({ used: 30, total: 100 })).toBe(70);
    expect(remainingOf({})).toBe(0);
  });
});
