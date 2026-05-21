import { FORMATS } from "../translator/formats.js";
import {
  initState,
  needsTranslation,
  translateRequest,
  translateResponse,
} from "../translator/index.js";
import { detectFormat, getTargetFormat } from "./provider.js";
import { parseModel } from "./model.js";
import {
  getModelStrip,
  getModelTargetFormat,
  PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.js";

const FORMAT_ALIASES = new Map([
  ["anthropic", FORMATS.CLAUDE],
  ["anthropic-messages", FORMATS.CLAUDE],
  ["claude", FORMATS.CLAUDE],
  ["messages", FORMATS.CLAUDE],
  ["openai-chat", FORMATS.OPENAI],
  ["chat-completions", FORMATS.OPENAI],
  ["chat", FORMATS.OPENAI],
  ["responses", FORMATS.OPENAI_RESPONSES],
  ["openai-response", FORMATS.OPENAI_RESPONSES],
]);

const KNOWN_FORMATS = new Set(Object.values(FORMATS));

export function normalizeFormat(format, fallback = null) {
  if (!format) return fallback;
  const normalized = String(format).trim().toLowerCase();
  return FORMAT_ALIASES.get(normalized) || (KNOWN_FORMATS.has(normalized) ? normalized : fallback);
}

export function resolveProviderTranslation({
  body,
  modelInfo = null,
  provider = null,
  model = null,
  sourceFormat = null,
  targetFormat = null,
  sourceFormatOverride = null,
} = {}) {
  const parsed = modelInfo || (body?.model ? parseModel(body.model) : {});
  const resolvedProvider = provider || parsed.provider || "openai";
  const resolvedModel = model || parsed.model || body?.model;
  const resolvedSourceFormat = normalizeFormat(sourceFormatOverride || sourceFormat, null) || detectFormat(body || {});

  const alias = PROVIDER_ID_TO_ALIAS[resolvedProvider] || resolvedProvider;
  const modelTargetFormat = resolvedModel ? getModelTargetFormat(alias, resolvedModel) : null;
  const defaultTargetFormat = resolvedProvider === "kimi" && resolvedSourceFormat === FORMATS.CLAUDE
    ? FORMATS.CLAUDE
    : (modelTargetFormat || getTargetFormat(resolvedProvider));
  const resolvedTargetFormat = normalizeFormat(targetFormat, defaultTargetFormat);

  return {
    provider: resolvedProvider,
    model: resolvedModel,
    sourceFormat: resolvedSourceFormat,
    targetFormat: resolvedTargetFormat,
    stripList: getModelStrip(alias, resolvedModel),
    translated: needsTranslation(resolvedSourceFormat, resolvedTargetFormat),
  };
}

export function translateProviderRequest({
  body,
  modelInfo = null,
  provider = null,
  model = null,
  sourceFormat = null,
  targetFormat = null,
  sourceFormatOverride = null,
  stream = true,
  credentials = null,
  reqLogger = null,
  stripList = null,
  connectionId = null,
  clientTool = null,
} = {}) {
  const resolved = resolveProviderTranslation({
    body,
    modelInfo,
    provider,
    model,
    sourceFormat,
    targetFormat,
    sourceFormatOverride,
  });
  const selectedStripList = Array.isArray(stripList) ? stripList : resolved.stripList;
  const translatedBody = translateRequest(
    resolved.sourceFormat,
    resolved.targetFormat,
    resolved.model,
    body,
    stream,
    credentials,
    resolved.provider,
    reqLogger,
    selectedStripList,
    connectionId,
    clientTool,
  );

  return {
    ...resolved,
    body: translatedBody,
    toolNameMap: translatedBody?._toolNameMap,
  };
}

export function translateProviderResponse({
  targetFormat,
  sourceFormat,
  chunk,
  state = null,
} = {}) {
  const resolvedTargetFormat = normalizeFormat(targetFormat, FORMATS.OPENAI);
  const resolvedSourceFormat = normalizeFormat(sourceFormat, FORMATS.OPENAI);
  const translationState = state || initState(resolvedSourceFormat);

  return {
    sourceFormat: resolvedSourceFormat,
    targetFormat: resolvedTargetFormat,
    state: translationState,
    chunks: translateResponse(resolvedTargetFormat, resolvedSourceFormat, chunk, translationState),
    translated: needsTranslation(resolvedSourceFormat, resolvedTargetFormat),
  };
}
