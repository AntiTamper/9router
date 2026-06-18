// Per-key policy helpers: model/combo exposure + effective token-saver.
// Used by the chat path (enforcement) and /v1/models (listing filter).

// Resolve the effective exposure rule for a key, applying the global default
// when the key has no explicit per-key restriction.
//   - per-key exposure.mode === "combo" + combo -> only that combo (+ members)
//   - otherwise follow global comboExposureMode:
//       "combo-only" -> only combos visible; "all-prefixed" -> everything
export function resolveExposure(keyConfig, settings) {
  const ex = keyConfig?.exposure;
  if (ex && ex.mode === "combo" && ex.combo) {
    return { mode: "combo", combo: String(ex.combo) };
  }
  const globalMode = settings?.comboExposureMode === "combo-only" ? "combo-only" : "all";
  return { mode: globalMode, combo: null };
}

// Decide whether a requested model string is allowed for this exposure.
//   exposure: from resolveExposure()
//   isCombo: true when modelStr is a combo name
//   allowedComboMembers: member list of exposure.combo (only needed for "combo")
export function isModelAllowed(exposure, { modelStr, isCombo = false, allowedComboMembers = null }) {
  if (!exposure || exposure.mode === "all") return true;
  if (exposure.mode === "combo-only") return isCombo === true;
  if (exposure.mode === "combo") {
    if (isCombo && modelStr === exposure.combo) return true;
    if (!isCombo && Array.isArray(allowedComboMembers) && allowedComboMembers.includes(modelStr)) return true;
    return false;
  }
  return true;
}

// Compute the effective token-saver flags for a request, honoring the global
// vs individual mode. Individual mode uses the key's own tokenSaver when set,
// else falls back to the global settings.
export function effectiveTokenSaver(settings, keyConfig) {
  const ts = keyConfig?.tokenSaver;
  if (settings?.tokenSaverMode === "individual" && ts) {
    return {
      rtkEnabled: ts.rtk === true,
      toonEnabled: ts.toon === true,
      cavemanEnabled: ts.caveman === true,
      cavemanLevel: typeof ts.cavemanLevel === "string" ? ts.cavemanLevel : "full",
      codexUsageEnabled: ts.codexUsage !== false,
    };
  }
  return {
    rtkEnabled: !!settings?.rtkEnabled,
    toonEnabled: !!settings?.toonEnabled,
    cavemanEnabled: !!settings?.cavemanEnabled,
    cavemanLevel: settings?.cavemanLevel || "full",
    codexUsageEnabled: settings?.codexUsageEnabled !== false,
  };
}
// Compute the effective custom system instruction for a request, honoring the
// global vs individual mode (mirrors effectiveTokenSaver). Individual mode uses
// the key's own customInstruction when enabled, else falls back to global.
export function effectiveCustomInstruction(settings, keyConfig) {
  const ci = keyConfig?.customInstruction;
  if (settings?.customInstructionMode === "individual" && ci && ci.enabled === true) {
    return {
      enabled: true,
      text: typeof ci.text === "string" ? ci.text : "",
      mode: ci.mode === "prepend" || ci.mode === "replace" ? ci.mode : "append",
    };
  }
  const gMode = settings?.customInstructionInjectMode;
  return {
    enabled: settings?.customInstructionEnabled === true,
    text: typeof settings?.customInstructionText === "string" ? settings.customInstructionText : "",
    mode: gMode === "prepend" || gMode === "replace" ? gMode : "append",
  };
}
// Resolve a key holder's effective self-service permissions. Per-key config
// overrides the global allowKeyHolder* default; null/undefined per-key value
// inherits the global default. Returns { tokenSaver: bool, overage: bool }.
export function resolveKeyHolderPermissions(keyConfig, settings) {
  const p = keyConfig?.permissions || {};
  const globalTs = settings?.allowKeyHolderTokenSaver === true;
  const globalOv = settings?.allowKeyHolderOverage === true;
  const globalCi = settings?.allowKeyHolderCustomInstruction === true;
  return {
    tokenSaver: p.tokenSaver === true ? true : p.tokenSaver === false ? false : globalTs,
    overage: p.overage === true ? true : p.overage === false ? false : globalOv,
    customInstruction: p.customInstruction === true ? true : p.customInstruction === false ? false : globalCi,
  };
}
