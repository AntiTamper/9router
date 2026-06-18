import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeAccountRoutingMode } from "../../../shared/utils/accountRouting.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  customDomainEnabled: false,
  customDomain: "",
  customDomainDashboardAccess: false,
  fallbackStrategy: "cycle",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  requireLogin: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  enableObservability: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  codexUsageEnabled: true,
  codexOAuthEvergreenEnabled: true,
  codexOAuthRefreshConcurrency: 1,
  codexOAuthRefreshMinIntervalHours: 12,
  codexOAuthKeepAliveHours: 72,
  codexOAuthRefreshLeadHours: 24,
  // Claude Code warmup (auto-ping): sends a minimal request so a fresh quota
  // window starts when the configured trigger condition is met.
  //  - enabled: master switch
  //  - warmupModel: claude model id used for the warmup ping
  //  - warmupTrigger: "out-of-quota" (fire when 5h window exhausted) |
  //                   "not-counting-down" (fire when window idle / no countdown) |
  //                   "on-reset" (legacy: fire right after the window flips)
  //  - connections: { [connectionId]: true } accounts opted in
  //  - overrides: { [connectionId]: { warmupModel?, warmupTrigger? } } per-conn override
  claudeAutoPing: {
    enabled: false,
    warmupModel: "claude-haiku-4-5-20251001",
    warmupTrigger: "out-of-quota",
    connections: {},
    overrides: {},
  },
  antigravityAutoPing: {
    enabled: false,
    warmupModel: "gemini-3-flash",
    warmupTrigger: "not-counting-down-or-out-of-quota",
    connections: {},
    overrides: {},
  },
  rtkEnabled: true,
  toonEnabled: false,
  cavemanEnabled: false,
  cavemanLevel: "full",
  // Token saver scope: "global" applies the settings above to every key;
  // "individual" lets each API key carry its own tokenSaver config (falling
  // back to global when a key has none).
  tokenSaverMode: "global",
  // Combo exposure default for keys with no explicit per-key exposure:
  // "all-prefixed" exposes every provider model by prefix; "combo-only"
  // exposes only combos. Per-key exposure overrides this default.
  comboExposureMode: "all-prefixed",
  // Self-service permissions for public /apikey key holders. When enabled, a
  // key holder authenticated by their own key may edit that key's own settings
  // via POST /api/apikey/settings. Default OFF (admin-only).
  allowKeyHolderTokenSaver: false,
  allowKeyHolderOverage: false,
  // Custom system-instruction injection (mirrors token saver). When enabled,
  // the text is injected into the system message of every request. Mode picks
  // how it combines with the client's own system prompt.
  customInstructionEnabled: false,
  customInstructionText: "",
  customInstructionMode: "global", // "global" | "individual"
  customInstructionInjectMode: "append", // "append" | "prepend" | "replace"
  allowKeyHolderCustomInstruction: false,
  quotaAutoToggleEnabled: true,
  quotaRefreshIntervalMs: null,
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  merged.fallbackStrategy = normalizeAccountRoutingMode(merged.fallbackStrategy);
  if (merged.providerStrategies && typeof merged.providerStrategies === "object") {
    merged.providerStrategies = Object.fromEntries(
      Object.entries(merged.providerStrategies).map(([providerId, override]) => {
        if (!override || typeof override !== "object") return [providerId, override];
        return [
          providerId,
          {
            ...override,
            ...(override.fallbackStrategy
              ? { fallbackStrategy: normalizeAccountRoutingMode(override.fallbackStrategy) }
              : {}),
          },
        ];
      }),
    );
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)]
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
