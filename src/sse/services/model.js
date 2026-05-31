// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getProviderAlias } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Always check provider-node prefix matching using original input first
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedOpenAI) {
      return { provider: matchedOpenAI.id, model: parsed.model };
    }

    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedAnthropic) {
      return { provider: matchedAnthropic.id, model: parsed.model };
    }

    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedEmbedding) {
      return { provider: matchedEmbedding.id, model: parsed.model };
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
// True when a combo member model is disabled in the dashboard's disabled-models
// list. The list is keyed by provider alias OR provider id -> array of bare
// model ids, so check every plausible key (mirrors the dashboard's own logic).
function isComboModelDisabled(modelStr, disabledMap) {
  const parsed = parseModel(modelStr);
  if (!parsed?.model) return false;
  const keys = new Set();
  if (parsed.providerAlias) keys.add(parsed.providerAlias);
  if (parsed.provider) {
    keys.add(parsed.provider);
    keys.add(getProviderAlias(parsed.provider));
  }
  for (const key of keys) {
    const list = disabledMap?.[key];
    if (Array.isArray(list) && list.includes(parsed.model)) return true;
  }
  return false;
}

export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (!combo || !combo.models || combo.models.length === 0) return null;

  // Respect the dashboard's disabled-models list BEFORE routing: silently skip
  // disabled combo members (with a log line) instead of routing to them and
  // eating 4xx/5xx until fallback. Returns [] (still a combo) when all disabled
  // so the combo handler can answer with a clear "no enabled models" error.
  let disabledMap = {};
  try { disabledMap = await getDisabledModels(); } catch { disabledMap = {}; }

  const enabled = [];
  for (const member of combo.models) {
    if (isComboModelDisabled(member, disabledMap)) {
      log.info("COMBO", `Combo "${modelStr}" skipped disabled model: ${member}`);
    } else {
      enabled.push(member);
    }
  }
  return enabled;
}
