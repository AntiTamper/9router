import { buildModelsList } from "@/app/api/v1/models/route.js";

export const dynamic = "force-dynamic";

const KIND_ALIASES = {
  llm: "llm",
  image: "image",
  tts: "tts",
  stt: "stt",
  embedding: "embedding",
  "image-to-text": "imageToText",
  imageToText: "imageToText",
  web: "webSearch",
  webSearch: "webSearch",
  webFetch: "webFetch",
};

function targetCandidates(rawModel) {
  const trimmed = String(rawModel || "").trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    candidates.push(trimmed.slice(slashIndex + 1));
  }
  return Array.from(new Set(candidates));
}

function normalizeKind(rawKind) {
  const key = String(rawKind || "llm").trim();
  return KIND_ALIASES[key] || "llm";
}

function splitModelId(fullId) {
  if (typeof fullId !== "string") return null;
  const slashIndex = fullId.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= fullId.length - 1) return null;
  return {
    providerAlias: fullId.slice(0, slashIndex),
    modelId: fullId.slice(slashIndex + 1),
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const candidates = targetCandidates(searchParams.get("model"));
    if (candidates.length === 0) {
      return Response.json({ error: "model is required" }, { status: 400 });
    }

    const includeRemoteFetches = !["0", "false", "no"].includes(String(searchParams.get("live") || "1").toLowerCase());
    const kind = normalizeKind(searchParams.get("kind"));
    const candidateSet = new Set(candidates);
    const data = await buildModelsList([kind], {
      includeRemoteFetches,
      staticFallbackOnNoConnections: false,
    });

    const seen = new Set();
    const matches = [];
    for (const entry of data || []) {
      if (!entry?.id || entry.owned_by === "combo") continue;
      const parsed = splitModelId(entry.id);
      if (!parsed || !candidateSet.has(parsed.modelId) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      matches.push({
        id: entry.id,
        providerAlias: parsed.providerAlias,
        modelId: parsed.modelId,
        owned_by: entry.owned_by,
        context_window: entry.context_window,
        max_input_tokens: entry.max_input_tokens,
      });
    }

    return Response.json({
      targetModel: matches[0]?.modelId || candidates[0],
      matches,
    });
  } catch (error) {
    console.log("Error matching models:", error);
    return Response.json({ error: "Failed to match models" }, { status: 500 });
  }
}
