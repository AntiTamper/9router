import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCustomModels } from "@/lib/localDb";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveModelContextWindow } from "open-sse/services/contextWindow.js";

const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  webSearch: "/v1/search",
  webFetch: "/v1/fetch",
};

const TTS_VOICES_API = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld", "local-device"]);

function buildInfo({ alias, providerId, model, kind, providerInfo }) {
  const out = {
    id: `${alias}/${model.id}`,
    name: model.name || model.id,
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (model.params) out.params = model.params;
  if (model.capabilities) out.capabilities = model.capabilities;
  if (model.options) out.options = model.options;
  if (model.dimensions) out.dimensions = model.dimensions;
  if (model.contextWindow) out.contextWindow = model.contextWindow;
  if (model.maxOutputTokens) out.maxOutputTokens = model.maxOutputTokens;
  if (kind === "tts" && TTS_VOICES_API.has(providerId)) {
    out.voicesUrl = `/v1/audio/voices?provider=${providerId}`;
  }
  if (kind === "webSearch" && providerInfo?.searchConfig) {
    const cfg = providerInfo.searchConfig;
    if (cfg.searchTypes) out.searchTypes = cfg.searchTypes;
    if (cfg.maxMaxResults) out.maxResults = cfg.maxMaxResults;
    if (cfg.requiredOptions) out.required = cfg.requiredOptions;
  }
  return out;
}

// id format: "{alias}/{modelId}" - alias may also be providerId
function lookup(fullId, ctx = {}) {
  if (!fullId || !fullId.includes("/")) return null;
  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const providerInfo = AI_PROVIDERS[providerId];

  // PROVIDER_MODELS lookup (by alias key, fallback to providerId)
  const list = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
  const m = list.find((x) => x.id === modelId);
  if (m) {
    const kind = m.type || "llm";
    return buildInfo({ alias, providerId, model: m, kind, providerInfo });
  }

  // Sub-configs (TTS/STT/embedding only-in-config)
  const subs = [
    ["tts", providerInfo?.ttsConfig],
    ["stt", providerInfo?.sttConfig],
    ["embedding", providerInfo?.embeddingConfig],
  ];
  for (const [kind, cfg] of subs) {
    const sm = cfg?.models?.find((x) => x.id === modelId);
    if (sm) return buildInfo({ alias, providerId, model: sm, kind, providerInfo });
  }

  // Web search/fetch — virtual model id "search" / "fetch"
  if (modelId === "search" && providerInfo?.searchConfig) {
    return buildInfo({
      alias, providerId, kind: "webSearch", providerInfo,
      model: { id: "search", name: `${providerInfo.name} Search`, params: ["query", "max_results", "country", "language", "time_range", "domain_filter", "search_type"] },
    });
  }
  if (modelId === "fetch" && providerInfo?.fetchConfig) {
    return buildInfo({
      alias, providerId, kind: "webFetch", providerInfo,
      model: { id: "fetch", name: `${providerInfo.name} Fetch`, params: ["url", "format", "max_characters"] },
    });
  }

  // Custom-model fallback (user-supplied via /api/models/custom)
  const cm = (ctx.customModels || []).find((x) =>
    (x?.providerAlias === alias || x?.providerAlias === providerId) && x?.id === modelId
  );
  if (cm) {
    const ctxWindow = Number(cm.contextWindow) || Number(cm.maxInputTokens) || null;
    const maxOut = Number(cm.maxOutputTokens) || null;
    return buildInfo({
      alias, providerId, providerInfo,
      kind: cm.type || "llm",
      model: {
        id: cm.id,
        name: cm.name || cm.id,
        contextWindow: ctxWindow,
        maxOutputTokens: maxOut,
      },
    });
  }

  // Live Kiro catalog fallback (kr/* aliases that aren't in static registry)
  if (providerId === "kiro" && Array.isArray(ctx.kiroLive)) {
    const live = ctx.kiroLive.find((x) => x?.id === modelId || x?.upstreamModelId === modelId);
    if (live) {
      return buildInfo({
        alias, providerId, providerInfo, kind: "llm",
        model: {
          id: live.id,
          name: live.name || live.id,
          contextWindow: Number(live.contextLength) || Number(live.contextWindow) || null,
          maxOutputTokens: Number(live.maxOutputTokens) || null,
        },
      });
    }
  }

  return null;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/models/info?id={alias}/{modelId} — metadata for a single model
async function loadLookupContext(id) {
  const ctx = { customModels: [], kiroLive: [] };
  try { ctx.customModels = await getCustomModels(); } catch {}
  try {
    const slash = id.indexOf("/");
    const alias = slash > 0 ? id.slice(0, slash) : "";
    if (alias === "kr" || alias === "kiro") {
      const { getProviderConnections } = await import("@/lib/localDb");
      const conns = await getProviderConnections().catch(() => []);
      const kiro = (conns || []).find((c) => c.provider === "kiro" && c.isActive !== false);
      if (kiro?.accessToken) {
        const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh");
        const live = await resolveKiroModels({
          accessToken: kiro.accessToken,
          refreshToken: kiro.refreshToken,
          providerSpecificData: kiro.providerSpecificData || {},
        }, {
          log: console,
          onCredentialsRefreshed: async (refreshed) => {
            if (!refreshed?.accessToken) return;
            await updateProviderCredentials(kiro.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken || kiro.refreshToken,
              expiresIn: refreshed.expiresIn,
            }).catch(() => {});
          },
        }).catch(() => null);
        if (Array.isArray(live?.models)) ctx.kiroLive = live.models;
      }
    }
  } catch {}
  return ctx;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return Response.json(
      { error: { message: "Missing required query param: id (e.g. ?id=openai/dall-e-3)", type: "invalid_request_error" } },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  const ctx = await loadLookupContext(id);
  // resolveModelContextWindow ensures clients always see a context window when one exists
  let info = lookup(id, ctx);
  if (info && (!info.contextWindow)) {
    const slash = id.indexOf("/");
    const alias = slash > 0 ? id.slice(0, slash) : "";
    const modelId = slash > 0 ? id.slice(slash + 1) : id;
    const providerId = ALIAS_TO_ID[alias] || alias;
    const resolved = resolveModelContextWindow({ alias, providerId, modelId, customModels: ctx.customModels, live: { kiro: ctx.kiroLive } });
    if (resolved.contextWindow) info.contextWindow = resolved.contextWindow;
    if (resolved.maxOutputTokens && !info.maxOutputTokens) info.maxOutputTokens = resolved.maxOutputTokens;
  }
  if (!info) {
    return Response.json(
      { error: { message: `Model not found: ${id}`, type: "not_found" } },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  return Response.json(info, { headers: { "Access-Control-Allow-Origin": "*" } });
}
