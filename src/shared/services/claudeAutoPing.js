// Provider warmup scheduler: sends a tiny request when a quota window needs to start.
import "open-sse/index.js";

import crypto from "crypto";
import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { getAntigravityUsage } from "open-sse/services/usage/google.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "open-sse/config/codexInstructions.js";
import { CLAUDE_CLI_SPOOF_HEADERS } from "open-sse/providers/shared.js";
import { ANTIGRAVITY_HEADERS, CLAUDE_SYSTEM_PROMPT, INTERNAL_REQUEST_HEADER } from "open-sse/config/appConstants.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { CLAUDE_AUTOPING_CONFIG } from "@/shared/constants/config";
import { PROVIDERS } from "open-sse/config/providers.js";

const C = CLAUDE_AUTOPING_CONFIG;
const CLAUDE_PING_URL = "https://api.anthropic.com/v1/messages?beta=true";
const ANTIGRAVITY_PING_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent";
const CODEX_PING_URL = "https://chatgpt.com/backend-api/codex/responses";
const TRIGGER_OUT = "out-of-quota";
const TRIGGER_IDLE = "not-counting-down";
const TRIGGER_BOTH = "not-counting-down-or-out-of-quota";
const TRIGGER_RESET = "on-reset";

const g = (global.__providerAutoWarmup ??= { interval: null, running: false, resetCache: {} });

function providerModels(provider) {
  return new Set((PROVIDERS?.[provider]?.models || []).map((m) => m.id));
}

const PROVIDER_CONFIG = {
  claude: {
    settingsKey: "claudeAutoPing",
    defaultModel: C.pingModel,
    defaultTrigger: TRIGGER_OUT,
    usage: (conn, proxyOptions) => getClaudeUsage(conn.accessToken, proxyOptions),
    pickWindows: (usage) => ({ session: usage?.quotas?.[C.fiveHourKey] || null }),
    send: sendClaudePing,
    validModels: providerModels("claude"),
  },
  antigravity: {
    settingsKey: "antigravityAutoPing",
    defaultModel: "gemini-3-flash",
    defaultTrigger: TRIGGER_BOTH,
    usage: (conn, proxyOptions) => getAntigravityUsage(conn.accessToken, conn.providerSpecificData || {}, proxyOptions),
    pickWindows: pickAntigravityWindows,
    send: sendAntigravityPing,
    validModels: providerModels("antigravity"),
  },
  codex: {
    settingsKey: "codexAutoPing",
    defaultModel: "gpt-5.3-codex-low",
    defaultTrigger: TRIGGER_BOTH,
    usage: (conn, proxyOptions) => getCodexUsage(conn.accessToken, proxyOptions),
    pickWindows: pickCodexWindows,
    send: sendCodexPing,
    validModels: providerModels("codex"),
  },
};

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

function resolveWarmupConfig(provider, settings, connId) {
  const cfg = PROVIDER_CONFIG[provider];
  const apCfg = settings?.[cfg.settingsKey] || {};
  const override = apCfg?.overrides?.[connId] || {};
  let model = override.warmupModel || apCfg?.warmupModel || cfg.defaultModel;
  if (cfg.validModels.size > 0 && !cfg.validModels.has(model)) model = cfg.defaultModel;
  const trigger = override.warmupTrigger || apCfg?.warmupTrigger || cfg.defaultTrigger;
  return { cfg, apCfg, model, trigger };
}

function percentUsed(quota) {
  if (!quota) return null;
  if (typeof quota.remainingPercentage === "number") return 100 - Math.max(0, Math.min(100, quota.remainingPercentage));
  const total = Number(quota.total || 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (Number(quota.used || 0) / total) * 100));
}

function hasResetClock(quota) {
  const resetMs = quota?.resetAt ? new Date(quota.resetAt).getTime() : null;
  return Number.isFinite(resetMs) && resetMs > Date.now();
}

function shouldWarmup(trigger, windows, state) {
  const session = windows.session;
  if (!session) return { should: false, nextState: state || {} };

  const used = percentUsed(session);
  const idle = used !== null && used <= 0 && !hasResetClock(session);
  const exhausted = used !== null && used >= 99;
  const resetAt = session.resetAt || "no-reset";
  const nextState = { ...(state || {}) };

  if (exhausted) nextState.exhaustedResetAt = resetAt;

  if (trigger === TRIGGER_RESET) {
    const resetMs = session.resetAt ? new Date(session.resetAt).getTime() : null;
    return { should: Number.isFinite(resetMs) && Date.now() >= resetMs - C.pingLeadMs, nextState };
  }

  if (trigger === TRIGGER_IDLE) return { should: idle, nextState };
  if (trigger === TRIGGER_BOTH) {
    const refillAfterExhaustion = idle && state?.exhaustedResetAt && state.exhaustedResetAt !== resetAt;
    return { should: idle || exhausted || refillAfterExhaustion, nextState };
  }
  return { should: exhausted, nextState };
}

function pickAntigravityWindows(usage) {
  const quotas = Object.values(usage?.quotas || {});
  const sessionRows = quotas.filter((q) => q?.window === "five_hour");
  const weeklyRows = quotas.filter((q) => q?.window === "weekly");
  const worst = (rows) => rows
    .map((q) => ({ q, used: percentUsed(q) }))
    .filter((x) => x.used !== null)
    .sort((a, b) => b.used - a.used)[0]?.q || null;
  return { session: worst(sessionRows) || worst(weeklyRows), weekly: worst(weeklyRows) };
}

function pickCodexWindows(usage) {
  const quotas = usage?.quotas || {};
  return {
    session: quotas.session || quotas.review_session || null,
    weekly: quotas.weekly || quotas.review_weekly || null,
  };
}

async function cancelResponseBody(res) {
  try { await res?.body?.cancel?.(); } catch { /* ignore */ }
}

// Codex UI model ids carry an effort suffix (-none/-low/-high/-xhigh) and an
// optional -review marker, but the upstream /responses endpoint only accepts the
// base id + reasoning.effort (the chat executor strips the suffix the same way).
// A direct warmup POST bypasses the executor, so we must normalize here or the
// ping 400s and never starts the session window.
const CODEX_EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh"];
function resolveCodexWarmupModel(model) {
  let id = String(model || "gpt-5.3-codex").trim();
  id = id.replace(/-review$/, "");
  let effort = "none";
  for (const level of CODEX_EFFORT_LEVELS) {
    if (id.endsWith(`-${level}`)) {
      effort = level;
      id = id.slice(0, -(level.length + 1));
      break;
    }
  }
  if (!id.startsWith("gpt-")) id = "gpt-5.3-codex";
  return { model: id, configuredEffort: effort };
}

function buildCodexWarmupRequest(conn, model) {
  const sessionId = `warmup-${conn.id || crypto.randomUUID()}`;
  const { model: upstreamModel } = resolveCodexWarmupModel(model);
  const workspaceId = conn.providerSpecificData?.workspaceId;
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.136.0",
      session_id: sessionId,
      ...(workspaceId ? { "chatgpt-account-id": workspaceId } : {}),
    },
    body: {
      model: upstreamModel,
      instructions: CODEX_DEFAULT_INSTRUCTIONS,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: C.pingText }] }],
      reasoning: { effort: "none", summary: "auto" },
      stream: true,
      store: false,
    },
  };
}

async function sendCodexPing(conn, proxyOptions, model) {
  const request = buildCodexWarmupRequest(conn, model);
  const res = await proxyAwareFetch(CODEX_PING_URL, {
    ...request,
    body: JSON.stringify(request.body),
  }, proxyOptions);
  await cancelResponseBody(res);
  return res.ok;
}
async function sendClaudePing(conn, proxyOptions, model) {
  const res = await proxyAwareFetch(CLAUDE_PING_URL, {
    method: "POST",
    headers: {
      ...CLAUDE_CLI_SPOOF_HEADERS,
      Authorization: `Bearer ${conn.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model || C.pingModel,
      max_tokens: C.pingMaxTokens,
      system: [{ type: "text", text: CLAUDE_SYSTEM_PROMPT }],
      messages: [{ role: "user", content: C.pingText }],
    }),
  }, proxyOptions);
  await cancelResponseBody(res);
  return res.ok;
}

async function sendAntigravityPing(conn, proxyOptions, model) {
  const sessionId = crypto.randomUUID() + Date.now().toString();
  const project = conn.projectId || conn.providerSpecificData?.projectId || "warmup-" + crypto.randomUUID().slice(0, 8);
  const res = await proxyAwareFetch(ANTIGRAVITY_PING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${conn.accessToken}`,
      "User-Agent": ANTIGRAVITY_HEADERS["User-Agent"],
      [INTERNAL_REQUEST_HEADER.name]: INTERNAL_REQUEST_HEADER.value,
      "X-Machine-Session-Id": sessionId,
      "x-request-source": "local",
      Accept: "application/json",
    },
    body: JSON.stringify({
      project,
      model,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: `agent-${crypto.randomUUID()}`,
      request: {
        contents: [{ role: "user", parts: [{ text: C.pingText }] }],
        generationConfig: { maxOutputTokens: C.pingMaxTokens },
        sessionId,
      },
    }),
  }, proxyOptions);
  await cancelResponseBody(res);
  return res.ok;
}

function warmupCycleKey(provider, resetAt) {
  return resetAt || `${provider}:idle`;
}

function shouldSkipWarmupCycle(state, cycleKey, resetAt, now = Date.now()) {
  const lastPingMs = new Date(state?.lastPingAt || 0).getTime();
  if (state?.lastPingOk === false && Number.isFinite(lastPingMs) && now - lastPingMs < C.failedRetryMs) return true;
  if (resetAt) return state?.lastPingedCycle === cycleKey;
  if (state?.lastPingedCycle !== cycleKey) return false;
  return Number.isFinite(lastPingMs) && now - lastPingMs < C.idleRetryMs;
}
async function pingConnection(provider, conn, settings) {
  const { cfg, model, trigger } = resolveWarmupConfig(provider, settings, conn.id);
  const state = conn.providerSpecificData?.warmupState || {};

  if (trigger === TRIGGER_RESET) {
    const cachedReset = g.resetCache[conn.id];
    if (cachedReset && Date.now() < new Date(cachedReset).getTime() - C.refreshAheadMs) return;
  }

  const proxyCfg = await resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyCfg);
  let connection = conn;
  try {
    const r = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = r.connection;
  } catch (e) {
    console.warn(`[AutoWarmup] ${provider}:${conn.id}: refresh failed: ${e.message}`);
    return;
  }

  const usage = await cfg.usage(connection, proxyOptions);
  const windows = cfg.pickWindows(usage);
  const resetAt = windows.session?.resetAt || null;
  if (resetAt) g.resetCache[conn.id] = resetAt;

  const decision = shouldWarmup(trigger, windows, state);
  const nextState = { ...decision.nextState, lastCheckedAt: new Date().toISOString() };
  if (!decision.should) {
    if (JSON.stringify(nextState) !== JSON.stringify(state)) {
      await updateProviderConnection(connection.id, { providerSpecificData: { ...(connection.providerSpecificData || {}), warmupState: nextState } });
    }
    return;
  }

  const cycleKey = warmupCycleKey(provider, resetAt);
  if (shouldSkipWarmupCycle(state, cycleKey, resetAt)) return;

  const ok = await cfg.send(connection, proxyOptions, model);
  await updateProviderConnection(connection.id, {
    lastPingedResetAt: resetAt,
    lastPingAt: new Date().toISOString(),
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
      warmupState: {
        ...nextState,
        lastPingedCycle: ok ? cycleKey : state.lastPingedCycle,
        lastPingOk: ok,
        lastPingModel: model,
        lastPingTrigger: trigger,
      },
    },
  });
  console.log(`[AutoWarmup] ${provider}:${connection.id}: ping ${ok ? "sent" : "failed"} model=${model} trigger=${trigger}`);
}

async function tickProvider(provider, settings) {
  const cfg = PROVIDER_CONFIG[provider];
  const apCfg = settings[cfg.settingsKey] || {};
  if (apCfg.enabled === false) return;
  const enabledMap = apCfg.connections || {};
  if (Object.keys(enabledMap).length === 0) return;

  const conns = await getProviderConnections({ provider, isActive: true });
  const targets = conns.filter((c) => c.authType === "oauth" && enabledMap[c.id] === true);
  for (const conn of targets) {
    try { await pingConnection(provider, conn, settings); }
    catch (e) { console.warn(`[AutoWarmup] ${provider}:${conn.id}: ${e.message}`); }
  }
}

async function tick() {
  if (g.running) return;
  g.running = true;
  try {
    const settings = await getSettings();
    for (const provider of Object.keys(PROVIDER_CONFIG)) await tickProvider(provider, settings);
  } catch (e) {
    console.warn("[AutoWarmup] tick error:", e.message);
  } finally {
    g.running = false;
  }
}

export function startClaudeAutoPing() {
  if (g.interval) return;
  g.interval = setInterval(() => { tick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
  tick().catch(() => {});
}

export const __autoWarmupTest = { shouldWarmup, pickAntigravityWindows, pickCodexWindows, percentUsed, warmupCycleKey, shouldSkipWarmupCycle, resolveCodexWarmupModel, buildCodexWarmupRequest };
