import { randomUUID } from "crypto";
import {
  acquireProviderConnectionRefreshLease,
  completeProviderConnectionRefreshLease,
  getProviderConnectionById,
  getProviderConnections,
  getSettings,
  markProviderConnectionReauthRequired,
  releaseProviderConnectionRefreshLease,
} from "../../lib/db/index.js";
import { OAUTH_ENDPOINTS } from "../../../open-sse/config/appConstants.js";
import { PROVIDERS } from "../../../open-sse/config/providers.js";

const HOUR_MS = 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 6 * HOUR_MS;
const STARTUP_DELAY_MS = 30 * 1000;
const JITTER_MS = 30 * 60 * 1000;
const LEASE_MS = 90 * 1000;
const WAITER_TIMEOUT_MS = 20 * 1000;
const WAITER_POLL_MS = 250;
const TOKEN_TIMEOUT_MS = 12 * 1000;
const TOKEN_BODY_CAP = 64 * 1024;
const UNRECOVERABLE_CODES = new Set(["invalid_grant", "refresh_token_reused", "invalid_token", "token_expired"]);
const PERMANENT_AUTH_CODES = new Set(["token_revoked", "token_invalid", "token_expired", ...UNRECOVERABLE_CODES]);

const state = global.__codexOAuthEvergreen ??= {
  timer: null,
  running: false,
  queue: Promise.resolve(),
  inFlightByConnection: new Map(),
};

function toMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function hourSetting(settings, key, fallback) {
  const n = Number(settings?.[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueue(task) {
  const run = state.queue.catch(() => {}).then(task);
  state.queue = run.catch(() => {});
  return run;
}

function summarizeReason(reason, code) {
  const raw = String(reason || code || "Codex OAuth refresh failed");
  return raw.replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 240);
}

export function isCodexOAuthRefreshable(connection) {
  if (!connection || connection.provider !== "codex") return false;
  if (connection.authType !== "oauth") return false;
  if (!connection.refreshToken) return false;
  const psd = connection.providerSpecificData || {};
  if (psd.reauthRequired === true) return false;
  if (psd.evergreen === false) return false;
  if (psd.authMethod === "access_token") return false;
  return true;
}

export function shouldRefreshCodexOAuthConnection(connection, settings = {}, now = Date.now(), options = {}) {
  if (!isCodexOAuthRefreshable(connection)) return false;
  const minIntervalMs = hourSetting(settings, "codexOAuthRefreshMinIntervalHours", 12) * HOUR_MS;
  const lastAttemptMs = toMs(connection.lastRefreshAttemptAt);
  if (options.respectMinInterval !== false && lastAttemptMs && now - lastAttemptMs < minIntervalMs) return false;

  const leadMs = hourSetting(settings, "codexOAuthRefreshLeadHours", 24) * HOUR_MS;
  const keepAliveMs = hourSetting(settings, "codexOAuthKeepAliveHours", 72) * HOUR_MS;
  const expiresAtMs = toMs(connection.expiresAt);
  const lastSuccessMs = toMs(connection.lastSuccessfulRefreshAt);
  const keepAliveBaselineMs = lastSuccessMs || toMs(connection.createdAt) || toMs(connection.updatedAt);

  if (expiresAtMs && expiresAtMs <= now + leadMs) return true;
  if (options.includeKeepAlive === false) return false;
  if (!keepAliveBaselineMs) return true;
  return now - keepAliveBaselineMs >= keepAliveMs;
}

function credentialsFromConnection(connection, extra = {}) {
  if (!connection) return null;
  return {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt,
    expiresIn: connection.expiresIn,
    providerSpecificData: connection.providerSpecificData || {},
    connectionId: connection.id,
    connection: connection,
    ...extra,
  };
}

async function boundedText(response, cap = TOKEN_BODY_CAP) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (size <= cap) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength || value.length || 0;
        chunks.push(value);
        if (size > cap) {
          try { await reader.cancel(); } catch {}
          break;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, cap));
  }
  if (typeof response?.text === "function") return (await response.text()).slice(0, cap);
  if (typeof response?.json === "function") return JSON.stringify(await response.json()).slice(0, cap);
  return "";
}

function parseRefreshError(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    const err = parsed?.error;
    return parsed?.error_code || parsed?.code || err?.code || (typeof err === "string" ? err : null);
  } catch {
    const lower = String(text || "").toLowerCase();
    return [...UNRECOVERABLE_CODES].find((code) => lower.includes(code)) || null;
  }
}

function parseAuthErrorCode(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    const err = parsed?.error;
    return parsed?.error_code || parsed?.code || err?.code || err?.type || (typeof err === "string" ? err : null);
  } catch {
    const lower = String(text || "").toLowerCase();
    return [...PERMANENT_AUTH_CODES].find((code) => lower.includes(code)) || null;
  }
}

async function requestCodexRefreshToken(refreshToken, { proxyOptions = null, fetchFn = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  timer.unref?.();
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: PROVIDERS.codex.clientId,
      scope: "openid profile email offline_access",
    });
    let runFetch = fetchFn || globalThis.fetch;
    if (!fetchFn && proxyOptions) {
      const mod = await import("open-sse/utils/proxyFetch.js");
      runFetch = (url, opts) => mod.proxyAwareFetch(url, opts, proxyOptions);
    }
    const response = await runFetch(OAUTH_ENDPOINTS.openai.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await boundedText(response);
    if (!response.ok) {
      const code = parseRefreshError(text);
      if (UNRECOVERABLE_CODES.has(code)) return { error: "unrecoverable_refresh_error", code, message: code };
      return { error: "refresh_failed", code, message: `token endpoint ${response.status}` };
    }
    const tokens = JSON.parse(text || "{}");
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
    };
  } catch (error) {
    return { error: "refresh_failed", code: error?.name || "network_error", message: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForLease(connectionId, previous, startedAt, timeoutMs = WAITER_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(WAITER_POLL_MS);
    const current = await getProviderConnectionById(connectionId);
    if (!current) return null;
    if (current.providerSpecificData?.reauthRequired) {
      return { error: "unrecoverable_refresh_error", reauthRequired: true, connection: current };
    }
    if (toMs(current.lastSuccessfulRefreshAt) >= startedAt - 1000) {
      return credentialsFromConnection(current, { refreshed: true, reusedPersisted: true });
    }
    if (previous?.refreshToken && current.refreshToken && current.refreshToken !== previous.refreshToken) {
      return credentialsFromConnection(current, { refreshed: true, reusedPersisted: true });
    }
    if (!current.refreshLeaseId || toMs(current.refreshLeaseUntil) <= Date.now()) break;
  }
  return null;
}

async function markReauth(connectionId, reason, code, leaseId = null) {
  const connection = await markProviderConnectionReauthRequired(connectionId, {
    reason: summarizeReason(reason, code),
    code,
    leaseId,
  });
  return { error: "unrecoverable_refresh_error", code, reauthRequired: true, connection };
}

async function refreshWithLease(connectionId, options = {}) {
  const settings = options.settings || await getSettings();
  let connection = typeof connectionId === "object" ? connectionId : await getProviderConnectionById(connectionId);
  if (!isCodexOAuthRefreshable(connection)) return null;
  if (!options.force && !shouldRefreshCodexOAuthConnection(connection, settings, Date.now(), { includeKeepAlive: options.includeKeepAlive !== false })) return null;

  const startedAt = Date.now();
  const leaseId = options.leaseId || randomUUID();
  const lease = await acquireProviderConnectionRefreshLease(connection.id, { leaseId, leaseMs: options.leaseMs || LEASE_MS, now: startedAt });
  if (!lease.acquired) return await waitForLease(connection.id, connection, startedAt, options.waitTimeoutMs || WAITER_TIMEOUT_MS);

  let leaseCompleted = false;
  try {
    connection = lease.connection || connection;
    const result = await requestCodexRefreshToken(connection.refreshToken, options);
    if (result?.accessToken) {
      const nowIso = new Date().toISOString();
      const expiresAt = result.expiresIn
        ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
        : connection.expiresAt;
      const update = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || connection.refreshToken,
        expiresAt,
        expiresIn: result.expiresIn || connection.expiresIn,
        lastSuccessfulRefreshAt: nowIso,
        testStatus: "active",
        lastError: null,
        lastErrorAt: null,
        errorCode: null,
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          evergreen: true,
          reauthRequired: false,
          reauthReason: null,
        },
      };
      const completed = await completeProviderConnectionRefreshLease(connection.id, leaseId, update);
      if (!completed.completed) return null;
      leaseCompleted = true;
      return credentialsFromConnection(completed.connection, { refreshed: true });
    }
    if (result?.error === "unrecoverable_refresh_error") {
      leaseCompleted = true;
      return await markReauth(connection.id, result.message || result.code, result.code, leaseId);
    }
    return null;
  } finally {
    if (!leaseCompleted) await releaseProviderConnectionRefreshLease(connection.id, leaseId);
  }
}

export async function safeRefreshCodexConnection(connectionOrId, options = {}) {
  const connectionId = typeof connectionOrId === "object" ? connectionOrId?.id : connectionOrId;
  if (!connectionId) return null;
  const hit = state.inFlightByConnection.get(connectionId);
  if (hit) return hit;
  const promise = enqueue(() => refreshWithLease(connectionOrId, options))
    .finally(() => state.inFlightByConnection.delete(connectionId));
  state.inFlightByConnection.set(connectionId, promise);
  return promise;
}

export async function refreshCodexConnectionIfDue(credentials, options = {}) {
  if (!credentials?.connectionId) return null;
  return safeRefreshCodexConnection(credentials.connectionId, { ...options, force: false, includeKeepAlive: false });
}

export async function getCodexOAuthRefreshCandidates(settings = null, now = Date.now()) {
  const resolvedSettings = settings || await getSettings();
  const connections = await getProviderConnections({ provider: "codex" });
  return connections.filter((connection) => shouldRefreshCodexOAuthConnection(connection, resolvedSettings, now));
}

export async function runCodexOAuthEvergreenPass() {
  if (state.running) return { skipped: "running", refreshed: 0 };
  state.running = true;
  try {
    const settings = await getSettings();
    if (settings.codexOAuthEvergreenEnabled === false) return { skipped: "disabled", refreshed: 0 };
    const candidates = await getCodexOAuthRefreshCandidates(settings);
    let refreshed = 0;
    let reauthRequired = 0;
    for (const connection of candidates) {
      const result = await safeRefreshCodexConnection(connection.id, { settings, reason: "evergreen" });
      if (result?.accessToken) refreshed++;
      if (result?.reauthRequired) reauthRequired++;
    }
    return { candidates: candidates.length, refreshed, reauthRequired };
  } finally {
    state.running = false;
  }
}

export function startCodexOAuthEvergreenSteward() {
  if (state.timer) return;
  const schedule = (delayMs) => {
    state.timer = setTimeout(async () => {
      await runCodexOAuthEvergreenPass().catch((error) => console.warn("[CodexOAuth] evergreen pass failed:", error?.message || error));
      const jitter = Math.floor(Math.random() * JITTER_MS);
      schedule(SCAN_INTERVAL_MS + jitter);
    }, delayMs);
    state.timer.unref?.();
  };
  schedule(STARTUP_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

export function isUnrecoverableCodexRefreshCode(code) {
  return UNRECOVERABLE_CODES.has(code);
}

export function isCodexAuthFailure(status, errorText = "") {
  if (status !== 401 && status !== 403) return false;
  const text = String(errorText || "").toLowerCase();
  const code = parseAuthErrorCode(errorText);
  if (PERMANENT_AUTH_CODES.has(code)) return true;
  return text.includes("invalidated oauth token") ||
    text.includes("authentication token has been invalidated") ||
    text.includes("authentication token is expired");
}

export async function markCodexConnectionReauthRequired(connectionId, reason = "Codex OAuth re-auth required", code = "reauth_required") {
  return markReauth(connectionId, reason, code);
}
