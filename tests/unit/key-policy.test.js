import { describe, it, expect } from "vitest";
import { resolveExposure, isModelAllowed, effectiveTokenSaver } from "../../src/lib/keyPolicy.js";

describe("keyPolicy.resolveExposure", () => {
  it("per-key combo exposure wins over global default", () => {
    const ex = resolveExposure({ exposure: { mode: "combo", combo: "premium" } }, { comboExposureMode: "all-prefixed" });
    expect(ex).toEqual({ mode: "combo", combo: "premium" });
  });

  it("falls back to global all-prefixed when no per-key exposure", () => {
    expect(resolveExposure({}, { comboExposureMode: "all-prefixed" })).toEqual({ mode: "all", combo: null });
  });

  it("falls back to global combo-only", () => {
    expect(resolveExposure(null, { comboExposureMode: "combo-only" })).toEqual({ mode: "combo-only", combo: null });
  });
});

describe("keyPolicy.isModelAllowed", () => {
  it("all -> everything allowed", () => {
    expect(isModelAllowed({ mode: "all" }, { modelStr: "cc/claude-opus-4-8" })).toBe(true);
  });

  it("combo-only -> only combos", () => {
    expect(isModelAllowed({ mode: "combo-only" }, { modelStr: "x", isCombo: true })).toBe(true);
    expect(isModelAllowed({ mode: "combo-only" }, { modelStr: "cc/m", isCombo: false })).toBe(false);
  });

  it("combo -> the combo name or its members", () => {
    const ex = { mode: "combo", combo: "premium" };
    expect(isModelAllowed(ex, { modelStr: "premium", isCombo: true })).toBe(true);
    expect(isModelAllowed(ex, { modelStr: "other", isCombo: true })).toBe(false);
    expect(isModelAllowed(ex, { modelStr: "cc/claude-opus-4-8", isCombo: false, allowedComboMembers: ["cc/claude-opus-4-8"] })).toBe(true);
    expect(isModelAllowed(ex, { modelStr: "kr/x", isCombo: false, allowedComboMembers: ["cc/claude-opus-4-8"] })).toBe(false);
  });
});

describe("keyPolicy.effectiveTokenSaver", () => {
  const global = { tokenSaverMode: "global", rtkEnabled: true, toonEnabled: false, cavemanEnabled: true, cavemanLevel: "ultra", codexUsageEnabled: true };

  it("uses global flags in global mode even when key has its own", () => {
    const out = effectiveTokenSaver(global, { tokenSaver: { rtk: false, toon: true, caveman: false, cavemanLevel: "lite", codexUsage: false } });
    expect(out).toEqual({ rtkEnabled: true, toonEnabled: false, cavemanEnabled: true, cavemanLevel: "ultra", codexUsageEnabled: true });
  });

  it("uses per-key flags in individual mode", () => {
    const settings = { ...global, tokenSaverMode: "individual" };
    const out = effectiveTokenSaver(settings, { tokenSaver: { rtk: false, toon: true, caveman: false, cavemanLevel: "lite", codexUsage: false } });
    expect(out).toEqual({ rtkEnabled: false, toonEnabled: true, cavemanEnabled: false, cavemanLevel: "lite", codexUsageEnabled: false });
  });

  it("falls back to global in individual mode when key has no tokenSaver", () => {
    const settings = { ...global, tokenSaverMode: "individual" };
    const out = effectiveTokenSaver(settings, {});
    expect(out.rtkEnabled).toBe(true);
    expect(out.cavemanLevel).toBe("ultra");
  });
});