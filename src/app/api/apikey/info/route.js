import { NextResponse } from "next/server";
import { getApiKeyBrief, getSettings, getComboByName } from "@/lib/localDb";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { resolveExposure, effectiveTokenSaver, effectiveCustomInstruction, resolveKeyHolderPermissions } from "@/lib/keyPolicy.js";
import { checkLookup, recordLookup, recordInvalid, getClientIp } from "@/lib/auth/apiKeyLookupLimiter";

export const dynamic = "force-dynamic";

// Public, key-as-login endpoint. Returns a read-only brief for the supplied API
// key ONLY. Rate-limited via a DEDICATED limiter (never the dashboard login
// limiter) so it cannot clear/trip admin login lockouts. Never reveals whether
// other keys exist.
//
//   GET  /api/apikey/info   Authorization: Bearer <key>   (or  x-api-key: <key>)
//   POST /api/apikey/info   body: { key }                 (used by the page form)

function jsonError(message, status, extraHeaders) {
  return NextResponse.json({ error: message }, { status, headers: extraHeaders });
}

// Extract the key from an incoming request: Authorization: Bearer, x-api-key
// header, or (POST) JSON body. Query-string keys are intentionally NOT accepted
// to avoid leaking secrets into URLs, proxies, and access logs.
async function extractKey(request) {
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m && m[1]) return m[1].trim();
  const xKey = request.headers.get("x-api-key");
  if (xKey && xKey.trim()) return xKey.trim();
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body && typeof body.key === "string") return body.key.trim();
    } catch {
      return null;
    }
  }
  return null;
}

async function buildBrief(key) {
  const brief = await getApiKeyBrief(key);
  if (!brief) return null;

  const settings = await getSettings();
  const exposure = resolveExposure(brief.config, settings);
  const saver = effectiveTokenSaver(settings, brief.config);
  const customInstruction = effectiveCustomInstruction(settings, brief.config);
  const perms = resolveKeyHolderPermissions(brief.config, settings);

  // Build the model list this key can actually use (LLM kind), applying the
  // same exposure filter as /v1/models.
  let models = [];
  try {
    const all = await buildModelsList(["llm"]);
    if (exposure.mode === "all") {
      models = all;
    } else if (exposure.mode === "combo-only") {
      models = all.filter((m) => m.owned_by === "combo");
    } else if (exposure.mode === "combo" && exposure.combo) {
      const combo = await getComboByName(exposure.combo);
      const memberSet = new Set(combo?.models || []);
      models = all.filter((m) => (m.owned_by === "combo" ? m.id === exposure.combo : memberSet.has(m.id)));
    } else {
      models = all;
    }
  } catch {
    models = [];
  }

  return {
    name: brief.name,
    status: brief.status,
    isActive: brief.isActive,
    expiresAt: brief.expiresAt,
    createdAt: brief.createdAt,
    usage: brief.usage,
    // Token-saver transforms applied to this key's requests.
    tokenSaver: {
      mode: settings.tokenSaverMode || "global",
      rtk: saver.rtkEnabled,
      toon: saver.toonEnabled,
      caveman: saver.cavemanEnabled,
      cavemanLevel: saver.cavemanLevel,
    },
    // Integration settings (NOT token-saver transforms).
    settings: {
      codexUsage: saver.codexUsageEnabled,
    },
    // The key's OWN stored token-saver config (used to prefill self-service
    // edits). Effective behavior is in tokenSaver above; this is the raw per-key
    // override (null when the key inherits global).
    tokenSaverConfig: brief.config?.tokenSaver || null,
    // Effective custom system instruction applied to this key's requests.
    customInstruction: {
      mode: settings.customInstructionMode || "global",
      enabled: customInstruction.enabled === true && !!(customInstruction.text || "").trim(),
      injectMode: customInstruction.mode || "append",
      // Preview only the first 280 chars to avoid returning huge prompts.
      preview: (customInstruction.text || "").slice(0, 280),
    },
    // The key's OWN stored custom-instruction config (prefill self-service edits).
    customInstructionConfig: brief.config?.customInstruction || null,
    // What this key holder is allowed to self-edit (admin-gated globals).
    permissions: {
      tokenSaver: perms.tokenSaver,
      tokenSaverMode: settings.tokenSaverMode || "global",
      overage: perms.overage,
      customInstruction: perms.customInstruction,
      customInstructionMode: settings.customInstructionMode || "global",
    },
    exposure,
    models: models.map((m) => ({ id: m.id, owned_by: m.owned_by, kind: m.kind || "llm" })),
  };
}

async function handle(request) {
  const ip = getClientIp(request);
  const limited = checkLookup(ip);
  if (limited.limited) {
    return jsonError("Too many requests. Try again later.", 429, { "Retry-After": String(limited.retryAfter) });
  }
  recordLookup(ip);

  const key = await extractKey(request);
  if (!key) {
    return jsonError("API key required", 400);
  }

  const brief = await buildBrief(key);
  if (!brief) {
    recordInvalid(ip);
    return jsonError("Invalid API key", 401);
  }
  return NextResponse.json(brief);
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}
