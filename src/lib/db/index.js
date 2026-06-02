// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  acquireProviderConnectionRefreshLease, completeProviderConnectionRefreshLease,
  releaseProviderConnectionRefreshLease, markProviderConnectionReauthRequired,
  getActiveCodexRefreshLeaseCount,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey,
  validateApiKey, checkApiKeyAccess, getApiKeyUsageSummary, getApiKeyConfigByValue, getApiKeyBrief, updateApiKeyTokenSaverByValue, updateApiKeyOverageByValue, updateApiKeyCustomInstructionByValue, resetApiKeyUsage, cleanupExpiredApiKeys,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getRequestDetailProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      machineId: r.machineId,
      isActive: r.isActive === 1,
      limitMode: r.limitMode || "unlimited",
      tokenLimit: r.tokenLimit || null,
      dailyTokenLimit: r.dailyTokenLimit || null,
      weeklyTokenLimit: r.weeklyTokenLimit || null,
      expiresAt: r.expiresAt || null,
      autoDeleteExpired: r.autoDeleteExpired !== 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt || r.createdAt,
    })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    usageHistory: db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory ORDER BY id ASC`).map((r) => ({
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      connectionId: r.connectionId,
      apiKey: r.apiKey,
      endpoint: r.endpoint,
      promptTokens: r.promptTokens || 0,
      completionTokens: r.completionTokens || 0,
      cost: r.cost || 0,
      status: r.status || "ok",
      tokens: parseJson(r.tokens, {}),
      meta: parseJson(r.meta, {}),
    })),
    usageDaily: db.all(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`).map((r) => ({
      dateKey: r.dateKey,
      data: parseJson(r.data, {}),
    })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);
    if (Array.isArray(payload.usageHistory)) db.run(`DELETE FROM usageHistory`);
    if (Array.isArray(payload.usageDaily)) db.run(`DELETE FROM usageDaily`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, limitMode, tokenLimit, dailyTokenLimit, weeklyTokenLimit, expiresAt, autoDeleteExpired, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          k.id, k.key, k.name || null, k.machineId || null,
          k.isActive === false ? 0 : 1,
          k.limitMode || "unlimited",
          k.tokenLimit || null,
          k.dailyTokenLimit || null,
          k.weeklyTokenLimit || null,
          k.expiresAt || null,
          k.autoDeleteExpired === false ? 0 : 1,
          k.createdAt || new Date().toISOString(),
          k.updatedAt || k.createdAt || new Date().toISOString(),
        ]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const u of payload.usageHistory || []) {
      const tokens = u.tokens && typeof u.tokens === "object"
        ? u.tokens
        : {
          prompt_tokens: u.promptTokens || 0,
          completion_tokens: u.completionTokens || 0,
        };
      const promptTokens = u.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0;
      const completionTokens = u.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0;
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          u.timestamp || new Date().toISOString(),
          u.provider || null,
          u.model || null,
          u.connectionId || null,
          u.apiKey || null,
          u.endpoint || null,
          promptTokens,
          completionTokens,
          u.cost || 0,
          u.status || "ok",
          stringifyJson(tokens),
          stringifyJson(u.meta || {}),
        ]
      );
    }
    for (const d of payload.usageDaily || []) {
      if (!d.dateKey) continue;
      db.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [d.dateKey, stringifyJson(d.data || {})]);
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Compute a stable conflict key for a provider connection (mirrors createProviderConnection dedup).
function connDedupKey(c) {
  if (c.authType === "oauth" && c.email) {
    const ws = c.providerSpecificData && c.providerSpecificData.chatgptAccountId;
    return `conn:oauth:${c.provider}:${c.email}:${ws || ""}`;
  }
  if (c.authType === "apikey" && c.name) {
    return `conn:apikey:${c.provider}:${c.name}`;
  }
  return null; // access_token / unkeyed: never dedup
}

// Inspect an import payload against the current DB and report, per table,
// which incoming records are NEW vs CONFLICTING (would overwrite an existing record).
export async function analyzeImport(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  const report = { tables: {}, totalAdds: 0, totalConflicts: 0, hasConflicts: false };
  const tally = (name, adds, conflicts) => {
    report.tables[name] = { adds, conflicts };
    report.totalAdds += adds;
    report.totalConflicts += conflicts;
  };

  // providerConnections: conflict by id OR dedup key
  {
    const rows = db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email }));
    const ids = new Set(rows.map((r) => r.id));
    const keys = new Set(rows.map(connDedupKey).filter(Boolean));
    let adds = 0, conflicts = 0;
    for (const c of payload.providerConnections || []) {
      const k = connDedupKey(c);
      if (ids.has(c.id) || (k && keys.has(k))) conflicts++; else adds++;
    }
    tally("providerConnections", adds, conflicts);
  }

  const simpleTable = (name, listKey, idField = "id") => {
    const ids = new Set(db.all(`SELECT ${idField} AS id FROM ${name}`).map((r) => r.id));
    let adds = 0, conflicts = 0;
    for (const item of payload[listKey] || []) {
      if (ids.has(item[idField])) conflicts++; else adds++;
    }
    tally(name, adds, conflicts);
  };
  simpleTable("providerNodes", "providerNodes");
  simpleTable("proxyPools", "proxyPools");
  simpleTable("apiKeys", "apiKeys");
  simpleTable("combos", "combos");

  report.hasConflicts = report.totalConflicts > 0;
  return report;
}

// Additive import: upsert records WITHOUT wiping existing data.
// conflictStrategy: "skip" = keep existing on conflict (add extras only);
//                   "overwrite" = replace existing record (destructive on conflict).
// Settings are shallow-merged. usageHistory is skipped to avoid duplicate rows.
export async function mergeDb(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const conflictStrategy = options.conflictStrategy === "overwrite" ? "overwrite" : "skip";
  const db = await getAdapter();
  const verb = conflictStrategy === "overwrite" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";

  db.transaction(() => {
    if (payload.settings && typeof payload.settings === "object") {
      const existingRow = db.all(`SELECT data FROM settings WHERE id = 1`)[0];
      const existing = existingRow ? parseJson(existingRow.data, {}) : {};
      const mergedSettings = { ...existing, ...payload.settings };
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(mergedSettings)]);
    }

    // providerConnections honor BOTH id and dedup-key conflicts.
    {
      const existingRows = db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email }));
      const idSet = new Set(existingRows.map((r) => r.id));
      const keyToId = new Map();
      for (const r of existingRows) { const k = connDedupKey(r); if (k) keyToId.set(k, r.id); }
      for (const c of payload.providerConnections || []) {
        const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
        const k = connDedupKey(c);
        const conflictId = idSet.has(id) ? id : (k && keyToId.has(k) ? keyToId.get(k) : null);
        if (conflictId) {
          if (conflictStrategy !== "overwrite") continue; // skip
          db.run(
            `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [conflictId, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
          );
        } else {
          db.run(
            `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
          );
        }
      }
    }

    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `${verb} INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `${verb} INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      db.run(
        `${verb} INTO apiKeys(id, key, name, machineId, isActive, limitMode, tokenLimit, dailyTokenLimit, weeklyTokenLimit, expiresAt, autoDeleteExpired, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          k.id, k.key, k.name || null, k.machineId || null,
          k.isActive === false ? 0 : 1,
          k.limitMode || "unlimited",
          k.tokenLimit || null,
          k.dailyTokenLimit || null,
          k.weeklyTokenLimit || null,
          k.expiresAt || null,
          k.autoDeleteExpired === false ? 0 : 1,
          k.createdAt || new Date().toISOString(),
          k.updatedAt || k.createdAt || new Date().toISOString(),
        ]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `${verb} INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`${verb} INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`${verb} INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`${verb} INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`${verb} INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}
// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
