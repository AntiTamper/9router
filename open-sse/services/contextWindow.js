// Generic per-model contextWindow resolver.
//
// Order of precedence (highest first):
//   1. User custom-model override (PROVIDER_MODELS at runtime is static, but
//      `getCustomModels()` rows can carry `contextWindow`/`maxInputTokens`).
//   2. Live upstream catalog (Kiro CodeWhisperer; Kimi /v1/models).
//   3. Static `PROVIDER_MODELS[*][i].contextWindow`.
//   4. `null` (caller can apply its own default — never silently 200_000).
//
// All callers that need a number can post-fall-back themselves; we never
// guess a value here so misconfigured static entries do not mask real bugs.

import { getStaticContextWindow, getStaticMaxOutputTokens, getFamilyContextWindow, getModelUpstreamId } from "../config/providerModels.js";
import { resolveKimiModels } from "./kimiModels.js";

const KIMI_PROVIDER_KEYS = new Set(["kimi", "kimi-api", "kimi-coding", "kmc"]);

function pickInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function fromCustomList(list, alias, providerId, modelId) {
  if (!Array.isArray(list)) return null;
  const m = list.find((x) =>
    (x?.providerAlias === alias || x?.providerAlias === providerId) && x?.id === modelId
  );
  if (!m) return null;
  return {
    contextWindow: pickInt(m.contextWindow) ?? pickInt(m.maxInputTokens),
    maxOutputTokens: pickInt(m.maxOutputTokens),
  };
}

function fromLiveList(list, modelId, alias, providerId) {
  if (!Array.isArray(list)) return null;
  const candidates = new Set([modelId]);
  const aliasUpstream = getModelUpstreamId(alias, modelId);
  const providerUpstream = getModelUpstreamId(providerId, modelId);
  if (aliasUpstream) candidates.add(aliasUpstream);
  if (providerUpstream) candidates.add(providerUpstream);
  const m = list.find((x) => candidates.has(x?.id) || candidates.has(x?.upstreamModelId));
  if (!m) return null;
  return {
    contextWindow: pickInt(m.contextWindow) ?? pickInt(m.contextLength) ?? pickInt(m.maxInputTokens),
    maxOutputTokens: pickInt(m.maxOutputTokens),
  };
}

/**
 * Resolve { contextWindow, maxOutputTokens } for a given alias/modelId.
 *
 * @param {object} params
 * @param {string} params.alias        - 9router alias (e.g. "kimi", "cc", "kr")
 * @param {string} params.providerId   - Internal provider id (e.g. "kimi-api")
 * @param {string} params.modelId      - Bare model id without alias prefix
 * @param {object} [params.live]       - Optional pre-fetched live catalog map
 *                                       e.g. { kiro: [{...}], kimi: [{...}] }
 * @param {Array}  [params.customModels] - Optional custom-model rows
 * @returns {{ contextWindow: number|null, maxOutputTokens: number|null, source: string }}
 */
export function resolveModelContextWindow({ alias, providerId, modelId, live, customModels }) {
  if (!modelId) return { contextWindow: null, maxOutputTokens: null, source: "none" };

  const fromCustom = fromCustomList(customModels, alias, providerId, modelId);
  if (fromCustom?.contextWindow) {
    return { ...fromCustom, source: "custom" };
  }

  // Live overrides keyed by alias or providerId
  const liveBucket = live?.[alias] || live?.[providerId];
  const fromLive = fromLiveList(liveBucket, modelId, alias, providerId);
  if (fromLive?.contextWindow) {
    return { ...fromLive, source: "live" };
  }

  const staticCtx = getStaticContextWindow(alias, modelId) ?? getStaticContextWindow(providerId, modelId);
  const staticOut = getStaticMaxOutputTokens(alias, modelId) ?? getStaticMaxOutputTokens(providerId, modelId);
  if (staticCtx) {
    return { contextWindow: staticCtx, maxOutputTokens: staticOut, source: "static" };
  }

  // Last resort: per-family default (e.g. cc -> 200000, gc -> 1048576). Lets
  // Codex/Kiro see *some* context window for models that lack explicit metadata.
  const familyCtx = getFamilyContextWindow(alias) ?? getFamilyContextWindow(providerId);
  if (familyCtx) {
    return { contextWindow: familyCtx, maxOutputTokens: staticOut, source: "family" };
  }

  return {
    contextWindow: null,
    maxOutputTokens: fromCustom?.maxOutputTokens || staticOut || null,
    source: "none",
  };
}

/**
 * Convenience: do a live Kimi catalog probe for the given credential and
 * return the parsed entries keyed by provider alias. Errors return an empty
 * object so callers can fold this safely into resolveModelContextWindow.
 */
export async function fetchKimiLiveCatalog(providerKey, credentials, options = {}) {
  if (!KIMI_PROVIDER_KEYS.has(providerKey)) return {};
  const result = await resolveKimiModels(providerKey, credentials, options).catch(() => null);
  if (!result?.models?.length) return {};
  const bucket = result.models;
  return { [providerKey]: bucket };
}

/**
 * Heuristic: detect upstream context-limit errors so callers can surface them
 * differently from generic 400s (e.g. trigger live-catalog refresh + advise
 * client to compact). Pattern matches real Moonshot/Kimi/Kiro/Anthropic
 * messages observed in the wild.
 */
const CONTEXT_LIMIT_RE = /\b(context(?:_length| window| limit)|token limit|too long|exceeds?.*(?:context|tokens|limit)|content_length_exceeds_threshold|maximum.*tokens)\b/i;

export function isContextLimitError(statusCode, message) {
  const status = Number(statusCode);
  if (!message) return false;
  const text = typeof message === "string" ? message : JSON.stringify(message);
  if (status !== 400 && status !== 413) return false;
  return CONTEXT_LIMIT_RE.test(text);
}
