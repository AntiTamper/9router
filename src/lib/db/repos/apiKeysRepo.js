import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export const API_KEY_LIMIT_MODES = new Set(["unlimited", "daily", "weekly", "daily_weekly", "hard"]);

function toIntOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}

function normalizeLimitMode(value) {
  const mode = typeof value === "string" ? value.toLowerCase() : "unlimited";
  return API_KEY_LIMIT_MODES.has(mode) ? mode : "unlimited";
}

function normalizeExpiresAt(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function expiryFromDurationMs(durationMs) {
  const n = Number(durationMs);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + Math.floor(n)).toISOString();
}

function parseConfig(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeHHMM(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^([0-1]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

// Build the authoritative structured config for a key. New keys store this in
// the `config` column; legacy keys (config null) derive an equivalent shape
// from limitMode + legacy token-limit columns so behavior is unchanged.
function deriveConfig(row, parsedConfig) {
  const cfg = parsedConfig && typeof parsedConfig === "object" ? { ...parsedConfig } : {};

  // Fusion limits: { daily, weekly, monthly, hard } (token counts, null = off).
  let limits = cfg.limits && typeof cfg.limits === "object" ? { ...cfg.limits } : null;
  if (!limits) {
    const mode = normalizeLimitMode(row.limitMode);
    limits = { daily: null, weekly: null, monthly: null, hard: null };
    if (mode === "daily") limits.daily = toIntOrNull(row.tokenLimit);
    else if (mode === "weekly") limits.weekly = toIntOrNull(row.tokenLimit);
    else if (mode === "hard") limits.hard = toIntOrNull(row.tokenLimit);
    else if (mode === "daily_weekly") {
      limits.daily = toIntOrNull(row.dailyTokenLimit);
      limits.weekly = toIntOrNull(row.weeklyTokenLimit);
    }
  } else {
    limits = {
      daily: toIntOrNull(limits.daily),
      weekly: toIntOrNull(limits.weekly),
      monthly: toIntOrNull(limits.monthly ?? row.monthlyTokenLimit),
      hard: toIntOrNull(limits.hard),
    };
  }
  if (limits.monthly == null) limits.monthly = toIntOrNull(row.monthlyTokenLimit);

  const hardCapAnchorAt = normalizeExpiresAt(cfg.hardCapAnchorAt) || null;

  const dw = cfg.dailyWindow && typeof cfg.dailyWindow === "object" ? cfg.dailyWindow : null;
  const dailyWindow = dw && normalizeHHMM(dw.start) && normalizeHHMM(dw.end)
    ? { start: normalizeHHMM(dw.start), end: normalizeHHMM(dw.end) }
    : null;

  const av = cfg.availability && typeof cfg.availability === "object" ? cfg.availability : null;
  let availability = null;
  if (av && (av.availableFrom || av.availableUntil)) {
    availability = {
      availableFrom: normalizeExpiresAt(av.availableFrom) || null,
      availableUntil: normalizeExpiresAt(av.availableUntil) || null,
    };
  }

  const ts = cfg.tokenSaver && typeof cfg.tokenSaver === "object" ? cfg.tokenSaver : null;
  const tokenSaver = ts
    ? {
        rtk: ts.rtk === true,
        toon: ts.toon === true,
        caveman: ts.caveman === true,
        cavemanLevel: typeof ts.cavemanLevel === "string" ? ts.cavemanLevel : "full",
        codexUsage: ts.codexUsage !== false,
      }
    : null;

  const ex = cfg.exposure && typeof cfg.exposure === "object" ? cfg.exposure : null;
  const exposure = ex && (ex.mode === "combo" || ex.mode === "all")
    ? { mode: ex.mode, combo: ex.mode === "combo" && ex.combo ? String(ex.combo) : null }
    : { mode: "all", combo: null };

  const ov = cfg.overage && typeof cfg.overage === "object" ? cfg.overage : null;
  let overage = null;
  if (ov && ov.enabled === true) {
    const ovWin = ov.window && typeof ov.window === "object" ? ov.window : null;
    overage = {
      enabled: true,
      limit: toIntOrNull(ov.limit),
      anchorAt: normalizeExpiresAt(ov.anchorAt) || null,
      window: ovWin && (ovWin.availableFrom || ovWin.availableUntil || ovWin.expiresAt)
        ? {
            availableFrom: normalizeExpiresAt(ovWin.availableFrom) || null,
            availableUntil: normalizeExpiresAt(ovWin.availableUntil || ovWin.expiresAt) || null,
          }
        : null,
    };
  }

  return { limits, hardCapAnchorAt, dailyWindow, availability, tokenSaver, exposure, overage };
}

function rowToKey(row) {
  if (!row) return null;
  const parsedConfig = parseConfig(row.config);
  const config = deriveConfig(row, parsedConfig);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    limitMode: normalizeLimitMode(row.limitMode),
    tokenLimit: toIntOrNull(row.tokenLimit),
    dailyTokenLimit: toIntOrNull(row.dailyTokenLimit),
    weeklyTokenLimit: toIntOrNull(row.weeklyTokenLimit),
    monthlyTokenLimit: toIntOrNull(row.monthlyTokenLimit),
    expiresAt: row.expiresAt || null,
    autoDeleteExpired: row.autoDeleteExpired === undefined || row.autoDeleteExpired === null
      ? true
      : row.autoDeleteExpired === 1 || row.autoDeleteExpired === true,
    config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt || row.createdAt,
  };
}

function getDayWindow(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

function getWeekWindow(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

function getMonthWindow(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end };
}

function getUsageResetWindow(period, key, now = new Date()) {
  if (period === "daily") return getDayWindow(now);
  if (period === "weekly") return getWeekWindow(now);
  if (period === "monthly") return getMonthWindow(now);
  return {
    start: null,
    end: null,
  };
}

function limitSummary(usage, limit, window = {}) {
  const normalizedLimit = toIntOrNull(limit);
  const remaining = normalizedLimit === null ? null : Math.max(0, normalizedLimit - usage.tokens);
  const remainingPercentage = normalizedLimit === null
    ? null
    : Math.max(0, Math.min(100, Math.round((remaining / normalizedLimit) * 100)));
  return {
    limit: normalizedLimit,
    used: usage.tokens,
    requests: usage.requests,
    remaining,
    remainingPercentage,
    windowStart: window.start ? window.start.toISOString() : null,
    resetAt: window.end ? window.end.toISOString() : null,
    lastUsedAt: usage.lastUsedAt,
    exhausted: normalizedLimit !== null && usage.tokens >= normalizedLimit,
  };
}

function mostConstrainedLimit(...limits) {
  const bounded = limits.filter((limit) => limit?.limit !== null);
  if (!bounded.length) return null;
  return bounded.sort((a, b) => (a.remainingPercentage ?? 100) - (b.remainingPercentage ?? 100))[0];
}

function sumUsage(db, apiKey, start = null, end = null, overageFilter = "any") {
  const where = ["apiKey = ?"];
  const params = [apiKey];
  if (start) {
    where.push("timestamp >= ?");
    params.push(start.toISOString());
  }
  if (end) {
    where.push("timestamp < ?");
    params.push(end.toISOString());
  }
  // overageFilter: "any" = all rows; "normal" = exclude overage-tagged;
  // "overage" = only overage-tagged. Legacy rows have overage = 0/NULL.
  if (overageFilter === "normal") where.push("COALESCE(overage, 0) = 0");
  else if (overageFilter === "overage") where.push("COALESCE(overage, 0) = 1");
  const row = db.get(
    `SELECT COALESCE(SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)), 0) AS tokens,
            COUNT(*) AS requests,
            MAX(timestamp) AS lastUsedAt
       FROM usageHistory
      WHERE ${where.join(" AND ")}`,
    params,
  );
  return {
    tokens: Number(row?.tokens || 0),
    requests: Number(row?.requests || 0),
    lastUsedAt: row?.lastUsedAt || null,
  };
}

function isOverageWindowActive(window, now = new Date()) {
  if (!window) return true;
  const t = now.getTime();
  if (window.availableFrom && new Date(window.availableFrom).getTime() > t) return false;
  if (window.availableUntil && new Date(window.availableUntil).getTime() <= t) return false;
  return true;
}

function buildUsageSummary(db, key, now = new Date()) {
  const cfg = key.config || {};
  const cfgLimits = cfg.limits || { daily: null, weekly: null, monthly: null, hard: null };

  const dailyWindow = getDayWindow(now);
  const weeklyWindow = getWeekWindow(now);
  const monthlyWindow = getMonthWindow(now);

  // Raw usage (any rows) drives the reported metrics.
  const total = sumUsage(db, key.key, null, null, "any");
  const dailyAny = sumUsage(db, key.key, dailyWindow.start, dailyWindow.end, "any");
  const weeklyAny = sumUsage(db, key.key, weeklyWindow.start, weeklyWindow.end, "any");
  const monthlyAny = sumUsage(db, key.key, monthlyWindow.start, monthlyWindow.end, "any");

  // Normal (non-overage) usage is what counts against the timed/hard limits.
  const dailyNorm = sumUsage(db, key.key, dailyWindow.start, dailyWindow.end, "normal");
  const weeklyNorm = sumUsage(db, key.key, weeklyWindow.start, weeklyWindow.end, "normal");
  const monthlyNorm = sumUsage(db, key.key, monthlyWindow.start, monthlyWindow.end, "normal");
  const hardAnchor = cfg.hardCapAnchorAt ? new Date(cfg.hardCapAnchorAt) : null;
  const hardNorm = sumUsage(db, key.key, hardAnchor, null, "normal");

  const limits = {
    daily: limitSummary(dailyNorm, cfgLimits.daily, dailyWindow),
    weekly: limitSummary(weeklyNorm, cfgLimits.weekly, weeklyWindow),
    monthly: limitSummary(monthlyNorm, cfgLimits.monthly, monthlyWindow),
    hard: limitSummary(hardNorm, cfgLimits.hard),
  };

  // Overage pool (above the timed limits). Counts overage-tagged usage since anchor.
  let overage = null;
  const ovCfg = cfg.overage;
  if (ovCfg && ovCfg.enabled && ovCfg.limit) {
    const ovAnchor = ovCfg.anchorAt ? new Date(ovCfg.anchorAt) : null;
    const ovUsed = sumUsage(db, key.key, ovAnchor, null, "overage").tokens;
    const windowActive = isOverageWindowActive(ovCfg.window, now);
    overage = {
      enabled: true,
      limit: ovCfg.limit,
      used: ovUsed,
      remaining: Math.max(0, ovCfg.limit - ovUsed),
      anchorAt: ovCfg.anchorAt || null,
      window: ovCfg.window || null,
      windowActive,
      exhausted: ovUsed >= ovCfg.limit,
    };
  }

  const activeTimed = [limits.daily, limits.weekly, limits.monthly].filter((l) => l.limit !== null);
  const timedBlocked = activeTimed.some((l) => l.exhausted);
  const hardBlocked = limits.hard.limit !== null && limits.hard.exhausted;
  const overageAvailable = !!(overage && overage.windowActive && !overage.exhausted);
  const blocked = hardBlocked || (timedBlocked && !overageAvailable);
  // A new request consumes overage when a timed limit blocks but overage saves it
  // (and the absolute hard cap is not itself blocking).
  const consumeOverage = !hardBlocked && timedBlocked && overageAvailable;

  const activeLimit = mostConstrainedLimit(limits.daily, limits.weekly, limits.monthly, limits.hard);

  return {
    mode: key.limitMode,
    limit: activeLimit?.limit ?? null,
    used: activeLimit?.used ?? total.tokens,
    requests: activeLimit?.requests ?? total.requests,
    totalUsed: total.tokens,
    totalRequests: total.requests,
    periods: {
      allTime: {
        used: total.tokens,
        requests: total.requests,
        lastUsedAt: total.lastUsedAt,
      },
      daily: {
        used: dailyAny.tokens,
        requests: dailyAny.requests,
        windowStart: dailyWindow.start.toISOString(),
        resetAt: dailyWindow.end.toISOString(),
        lastUsedAt: dailyAny.lastUsedAt,
      },
      weekly: {
        used: weeklyAny.tokens,
        requests: weeklyAny.requests,
        windowStart: weeklyWindow.start.toISOString(),
        resetAt: weeklyWindow.end.toISOString(),
        lastUsedAt: weeklyAny.lastUsedAt,
      },
      monthly: {
        used: monthlyAny.tokens,
        requests: monthlyAny.requests,
        windowStart: monthlyWindow.start.toISOString(),
        resetAt: monthlyWindow.end.toISOString(),
        lastUsedAt: monthlyAny.lastUsedAt,
      },
    },
    limits,
    overage,
    consumeOverage,
    remaining: activeLimit?.remaining ?? null,
    remainingPercentage: activeLimit?.remainingPercentage ?? null,
    windowStart: activeLimit?.windowStart ?? null,
    resetAt: activeLimit?.resetAt ?? null,
    lastUsedAt: activeLimit?.lastUsedAt || total.lastUsedAt,
    exhausted: blocked,
  };
}

function isWithinDailyWindow(dailyWindow, now = new Date()) {
  if (!dailyWindow || !dailyWindow.start || !dailyWindow.end) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = dailyWindow.start.split(":").map(Number);
  const [eh, em] = dailyWindow.end.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return true; // full-day / no restriction
  if (startMin < endMin) return mins >= startMin && mins < endMin;
  // Overnight window (e.g. 22:00-06:00)
  return mins >= startMin || mins < endMin;
}

function availabilityState(availability, now = new Date()) {
  if (!availability) return "ok";
  const t = now.getTime();
  if (availability.availableFrom && new Date(availability.availableFrom).getTime() > t) return "not_yet";
  if (availability.availableUntil && new Date(availability.availableUntil).getTime() <= t) return "ended";
  return "ok";
}

function getKeyStatus(key, usage, now = new Date()) {
  if (!key.isActive) return "paused";
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime()) return "expired";
  const cfg = key.config || {};
  const avail = availabilityState(cfg.availability, now);
  if (avail === "ended") return "expired";
  if (avail === "not_yet") return "unavailable";
  if (!isWithinDailyWindow(cfg.dailyWindow, now)) return "outside_hours";
  if (usage.exhausted) return "exhausted";
  return "active";
}

async function hydrateKey(db, row, includeUsage = false, now = new Date()) {
  const key = rowToKey(row);
  if (!key) return null;
  if (!includeUsage) return key;
  const usage = buildUsageSummary(db, key, now);
  return { ...key, usage, status: getKeyStatus(key, usage, now) };
}

// Merge the structured `config` object from input over an existing key config.
// `input.config` (if present) is the authoritative structured shape; otherwise
// legacy fields (limitMode + *TokenLimit) are folded into a config so old API
// callers keep working unchanged.
function buildStructuredConfig(input = {}, existing = {}) {
  const existingCfg = existing.config || {};
  const inCfg = input.config && typeof input.config === "object" ? input.config : null;

  // Limits
  let limits;
  if (inCfg && inCfg.limits && typeof inCfg.limits === "object") {
    limits = {
      daily: toIntOrNull(inCfg.limits.daily),
      weekly: toIntOrNull(inCfg.limits.weekly),
      monthly: toIntOrNull(inCfg.limits.monthly),
      hard: toIntOrNull(inCfg.limits.hard),
    };
  } else if (input.limitMode !== undefined || input.tokenLimit !== undefined
      || input.dailyTokenLimit !== undefined || input.weeklyTokenLimit !== undefined) {
    // Legacy-mode input -> derive limits
    const mode = normalizeLimitMode(input.limitMode ?? existing.limitMode);
    limits = { daily: null, weekly: null, monthly: null, hard: null };
    if (mode === "daily") limits.daily = toIntOrNull(input.tokenLimit ?? existing.tokenLimit);
    else if (mode === "weekly") limits.weekly = toIntOrNull(input.tokenLimit ?? existing.tokenLimit);
    else if (mode === "hard") limits.hard = toIntOrNull(input.tokenLimit ?? existing.tokenLimit);
    else if (mode === "daily_weekly") {
      limits.daily = toIntOrNull(input.dailyTokenLimit ?? existing.dailyTokenLimit);
      limits.weekly = toIntOrNull(input.weeklyTokenLimit ?? existing.weeklyTokenLimit);
    }
  } else {
    limits = existingCfg.limits || { daily: null, weekly: null, monthly: null, hard: null };
  }

  const src = inCfg || {};
  const pick = (k, fallback) => (src[k] !== undefined ? src[k] : fallback);

  // Hard cap anchor: (re)set when hard limit becomes active and no anchor yet.
  let hardCapAnchorAt = normalizeExpiresAt(pick("hardCapAnchorAt", existingCfg.hardCapAnchorAt)) || null;
  if (limits.hard && !hardCapAnchorAt) hardCapAnchorAt = new Date().toISOString();
  if (!limits.hard) hardCapAnchorAt = null;

  const dwIn = pick("dailyWindow", existingCfg.dailyWindow);
  const dailyWindow = dwIn && normalizeHHMM(dwIn.start) && normalizeHHMM(dwIn.end)
    ? { start: normalizeHHMM(dwIn.start), end: normalizeHHMM(dwIn.end) }
    : null;

  const avIn = pick("availability", existingCfg.availability);
  const availability = avIn && (avIn.availableFrom || avIn.availableUntil)
    ? {
        availableFrom: normalizeExpiresAt(avIn.availableFrom) || null,
        availableUntil: normalizeExpiresAt(avIn.availableUntil) || null,
      }
    : null;

  const tsIn = pick("tokenSaver", existingCfg.tokenSaver);
  const tokenSaver = tsIn && typeof tsIn === "object"
    ? {
        rtk: tsIn.rtk === true,
        toon: tsIn.toon === true,
        caveman: tsIn.caveman === true,
        cavemanLevel: typeof tsIn.cavemanLevel === "string" ? tsIn.cavemanLevel : "full",
        codexUsage: tsIn.codexUsage !== false,
      }
    : null;

  const exIn = pick("exposure", existingCfg.exposure);
  const exposure = exIn && (exIn.mode === "combo" || exIn.mode === "all")
    ? { mode: exIn.mode, combo: exIn.mode === "combo" && exIn.combo ? String(exIn.combo) : null }
    : { mode: "all", combo: null };

  const ovIn = pick("overage", existingCfg.overage);
  let overage = null;
  if (ovIn && ovIn.enabled === true) {
    const existingOv = existingCfg.overage || {};
    let anchorAt = normalizeExpiresAt(ovIn.anchorAt ?? existingOv.anchorAt) || null;
    if (!anchorAt) anchorAt = new Date().toISOString();
    const ow = ovIn.window && typeof ovIn.window === "object" ? ovIn.window : null;
    overage = {
      enabled: true,
      limit: toIntOrNull(ovIn.limit),
      anchorAt,
      window: ow && (ow.availableFrom || ow.availableUntil || ow.expiresAt)
        ? {
            availableFrom: normalizeExpiresAt(ow.availableFrom) || null,
            availableUntil: normalizeExpiresAt(ow.availableUntil || ow.expiresAt) || null,
          }
        : null,
    };
  }

  return { limits, hardCapAnchorAt, dailyWindow, availability, tokenSaver, exposure, overage };
}

function buildKeyConfig(input = {}, existing = {}) {
  const structured = buildStructuredConfig(input, existing);
  const { limits } = structured;

  // Maintain legacy columns so old readers + UI keep working.
  let limitMode = "unlimited";
  const active = [];
  if (limits.daily) active.push("daily");
  if (limits.weekly) active.push("weekly");
  if (limits.monthly) active.push("monthly");
  if (limits.hard) active.push("hard");
  if (active.length === 1) limitMode = active[0] === "monthly" ? "hard" : active[0];
  else if (limits.daily && limits.weekly) limitMode = "daily_weekly";
  else if (limits.hard) limitMode = "hard";
  else if (active.length >= 2) limitMode = "daily_weekly";

  const tokenLimit = limitMode === "hard"
    ? (limits.hard ?? limits.monthly ?? null)
    : limitMode === "daily"
      ? limits.daily
      : limitMode === "weekly"
        ? limits.weekly
        : null;
  const dailyTokenLimit = limits.daily;
  const weeklyTokenLimit = limits.weekly;
  const monthlyTokenLimit = limits.monthly;

  const expiresAt = Object.prototype.hasOwnProperty.call(input, "expiresInMs")
    ? expiryFromDurationMs(input.expiresInMs)
    : Object.prototype.hasOwnProperty.call(input, "expiresAt")
      ? normalizeExpiresAt(input.expiresAt)
      : (existing.expiresAt || null);
  const autoDeleteExpired = Object.prototype.hasOwnProperty.call(input, "autoDeleteExpired")
    ? input.autoDeleteExpired !== false
    : (existing.autoDeleteExpired !== false);

  return {
    limitMode,
    tokenLimit,
    dailyTokenLimit,
    weeklyTokenLimit,
    monthlyTokenLimit,
    expiresAt,
    autoDeleteExpired,
    config: structured,
    configJson: JSON.stringify(structured),
  };
}

export async function cleanupExpiredApiKeys(now = new Date()) {
  const db = await getAdapter();
  const res = db.run(
    `DELETE FROM apiKeys
      WHERE autoDeleteExpired = 1
        AND expiresAt IS NOT NULL
        AND expiresAt != ''
        AND expiresAt <= ?`,
    [now.toISOString()],
  );
  return res?.changes ?? 0;
}

export async function getApiKeys(options = {}) {
  const db = await getAdapter();
  await cleanupExpiredApiKeys();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return Promise.all(rows.map((row) => hydrateKey(db, row, options.includeUsage === true)));
}

export async function getApiKeyById(id, options = {}) {
  const db = await getAdapter();
  await cleanupExpiredApiKeys();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return hydrateKey(db, row, options.includeUsage === true);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const now = new Date().toISOString();
  const config = buildKeyConfig(options);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    ...config,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, limitMode, tokenLimit, dailyTokenLimit, weeklyTokenLimit, monthlyTokenLimit, config, expiresAt, autoDeleteExpired, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1,
      apiKey.limitMode, apiKey.tokenLimit, apiKey.dailyTokenLimit, apiKey.weeklyTokenLimit, apiKey.monthlyTokenLimit ?? null,
      config.configJson, apiKey.expiresAt,
      apiKey.autoDeleteExpired ? 1 : 0, apiKey.createdAt, apiKey.updatedAt,
    ],
  );
  return { ...apiKey, usage: buildUsageSummary(db, apiKey), status: "active" };
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToKey(row);
    const config = buildKeyConfig(data, existing);
    const merged = {
      ...existing,
      ...data,
      ...config,
      isActive: data.isActive !== undefined ? data.isActive === true : existing.isActive,
      updatedAt: new Date().toISOString(),
    };
    db.run(
      `UPDATE apiKeys
          SET key = ?, name = ?, machineId = ?, isActive = ?, limitMode = ?,
              tokenLimit = ?, dailyTokenLimit = ?, weeklyTokenLimit = ?, monthlyTokenLimit = ?,
              config = ?, expiresAt = ?, autoDeleteExpired = ?, updatedAt = ?
        WHERE id = ?`,
      [
        merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
        merged.limitMode, merged.tokenLimit, merged.dailyTokenLimit, merged.weeklyTokenLimit, merged.monthlyTokenLimit ?? null,
        config.configJson, merged.expiresAt,
        merged.autoDeleteExpired ? 1 : 0, merged.updatedAt, id,
      ],
    );
    const usage = buildUsageSummary(db, merged);
    result = { ...merged, usage, status: getKeyStatus(merged, usage) };
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

function rebuildUsageDaily(db) {
  db.run(`DELETE FROM usageDaily`);
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens FROM usageHistory ORDER BY id ASC`);
  const days = new Map();

  for (const row of rows) {
    const d = new Date(row.timestamp);
    if (!Number.isFinite(d.getTime())) continue;
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!days.has(dateKey)) {
      days.set(dateKey, {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
        byProvider: {},
        byModel: {},
        byAccount: {},
        byApiKey: {},
        byEndpoint: {},
      });
    }
    const day = days.get(dateKey);
    const promptTokens = Number(row.promptTokens || 0);
    const completionTokens = Number(row.completionTokens || 0);
    const cost = Number(row.cost || 0);
    const values = { requests: 1, promptTokens, completionTokens, cost };

    day.requests += 1;
    day.promptTokens += promptTokens;
    day.completionTokens += completionTokens;
    day.cost += cost;

    const add = (target, key, extra = {}) => {
      if (!key) return;
      if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, ...extra };
      target[key].requests += values.requests;
      target[key].promptTokens += values.promptTokens;
      target[key].completionTokens += values.completionTokens;
      target[key].cost += values.cost;
    };

    add(day.byProvider, row.provider);
    add(day.byModel, row.provider ? `${row.model}|${row.provider}` : row.model, { rawModel: row.model, provider: row.provider });
    add(day.byAccount, row.connectionId, { rawModel: row.model, provider: row.provider });
    const apiKeyValue = row.apiKey || "local-no-key";
    add(day.byApiKey, `${apiKeyValue}|${row.model}|${row.provider || "unknown"}`, { rawModel: row.model, provider: row.provider, apiKey: row.apiKey || null });
    const endpoint = row.endpoint || "Unknown";
    add(day.byEndpoint, `${endpoint}|${row.model}|${row.provider || "unknown"}`, { endpoint, rawModel: row.model, provider: row.provider });
  }

  for (const [dateKey, data] of days) {
    db.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [dateKey, JSON.stringify(data)]);
  }
}

export async function resetApiKeyUsage(id, period = "all") {
  const allowed = ["all", "daily", "weekly", "monthly", "hard", "overage"];
  const normalizedPeriod = allowed.includes(period) ? period : "all";
  const db = await getAdapter();
  let result = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    const key = rowToKey(row);
    if (!key) return;

    let deleted = 0;
    const nowIso = new Date().toISOString();

    if (normalizedPeriod === "hard") {
      // Re-anchor the hard cap so usage counts from now (non-destructive).
      const cfg = { ...(key.config || {}), hardCapAnchorAt: key.config?.limits?.hard ? nowIso : null };
      key.config = cfg;
      db.run(`UPDATE apiKeys SET config = ?, updatedAt = ? WHERE id = ?`, [JSON.stringify(cfg), nowIso, id]);
    } else if (normalizedPeriod === "overage") {
      // Re-anchor the overage pool + drop overage-tagged accounting so used = 0.
      if (key.config?.overage?.enabled) {
        const cfg = { ...key.config, overage: { ...key.config.overage, anchorAt: nowIso } };
        key.config = cfg;
        db.run(`UPDATE apiKeys SET config = ?, updatedAt = ? WHERE id = ?`, [JSON.stringify(cfg), nowIso, id]);
      }
      const res = db.run(`DELETE FROM usageHistory WHERE apiKey = ? AND COALESCE(overage, 0) = 1`, [key.key]);
      deleted = res?.changes ?? 0;
      rebuildUsageDaily(db);
    } else {
      const { start, end } = getUsageResetWindow(normalizedPeriod, key);
      const where = ["apiKey = ?"];
      const params = [key.key];
      if (start) { where.push("timestamp >= ?"); params.push(start.toISOString()); }
      if (end) { where.push("timestamp < ?"); params.push(end.toISOString()); }
      const res = db.run(`DELETE FROM usageHistory WHERE ${where.join(" AND ")}`, params);
      deleted = res?.changes ?? 0;
      rebuildUsageDaily(db);
    }

    const usage = buildUsageSummary(db, key);
    result = {
      deleted,
      period: normalizedPeriod,
      key: { ...key, usage, status: getKeyStatus(key, usage) },
    };
  });

  return result;
}

// Lightweight read of a key's structured config by key value (no usage scan).
// Returns null when the key does not exist. Used by /v1/models exposure filter.
// Public-safe brief for the /apikey page. Looks a key up by value and returns
// only display-safe fields (no key string, no machineId). Returns null when
// the key does not exist.
export async function getApiKeyBrief(keyValue) {
  if (!keyValue) return null;
  const db = await getAdapter();
  await cleanupExpiredApiKeys();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [keyValue]);
  const key = rowToKey(row);
  if (!key) return null;
  const usage = buildUsageSummary(db, key);
  const status = getKeyStatus(key, usage);
  return {
    name: key.name || null,
    isActive: key.isActive,
    status,
    limitMode: key.limitMode,
    expiresAt: key.expiresAt,
    createdAt: key.createdAt,
    usage,
    config: key.config,
  };
}

export async function getApiKeyConfigByValue(keyValue) {
  if (!keyValue) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [keyValue]);
  const key = rowToKey(row);
  return key ? key.config : null;
}

export async function getApiKeyUsageSummary(keyValue) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [keyValue]);
  const key = rowToKey(row);
  if (!key) return null;
  const usage = buildUsageSummary(db, key);
  return { ...usage, status: getKeyStatus(key, usage) };
}

export async function checkApiKeyAccess(keyValue) {
  if (!keyValue) return { valid: false, reason: "missing" };
  const db = await getAdapter();
  await cleanupExpiredApiKeys();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [keyValue]);
  const key = rowToKey(row);
  if (!key) return { valid: false, reason: "invalid" };

  const now = new Date();
  const usage = buildUsageSummary(db, key, now);
  const status = getKeyStatus(key, usage, now);

  if (status === "paused") return { valid: false, reason: "paused", key, usage, status };
  if (status === "expired") return { valid: false, reason: "expired", key, usage, status };
  if (status === "unavailable") return { valid: false, reason: "not_yet_available", key, usage, status };
  if (status === "outside_hours") return { valid: false, reason: "outside_authorized_hours", key, usage, status };
  if (status === "exhausted") {
    return {
      valid: false,
      reason: "token_limit_exceeded",
      key,
      usage,
      status,
      resetAt: usage.resetAt,
    };
  }

  // consumeOverage = this request is only permitted because the overage pool
  // covers it (a timed limit is exhausted). The write path tags usage overage=1.
  return { valid: true, reason: "ok", key, usage, status, consumeOverage: usage.consumeOverage === true };
}

// Sync write-time overage classifier. Given the api key string, returns true
// when the next request should be tagged as overage (a timed limit is already
// exhausted by NORMAL usage and the overage pool is enabled/active/not full).
// Uses the same logic as buildUsageSummary.consumeOverage. Safe in a usage
// transaction (synchronous, no JS yield).
export function classifyOverageAtWrite(db, apiKeyValue, now = new Date()) {
  if (!apiKeyValue) return false;
  try {
    const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [apiKeyValue]);
    const key = rowToKey(row);
    if (!key || !key.config?.overage?.enabled) return false;
    const usage = buildUsageSummary(db, key, now);
    return usage.consumeOverage === true;
  } catch {
    return false;
  }
}

export async function validateApiKey(key) {
  const access = await checkApiKeyAccess(key);
  return access.valid === true;
}
