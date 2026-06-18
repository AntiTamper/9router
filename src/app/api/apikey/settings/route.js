import { NextResponse } from "next/server";
import {
  getApiKeyBrief,
  getSettings,
  updateApiKeyTokenSaverByValue,
  updateApiKeyOverageByValue,
  updateApiKeyCustomInstructionByValue,
} from "@/lib/localDb";
import { checkLookup, recordLookup, recordInvalid, getClientIp } from "@/lib/auth/apiKeyLookupLimiter";
import { resolveKeyHolderPermissions } from "@/lib/keyPolicy.js";

export const dynamic = "force-dynamic";

// POST /api/apikey/settings
// Key-holder self-service write endpoint. Authenticated by the API key itself
// (Authorization: Bearer <key>, x-api-key, or body.key). Each edit is gated by a
// global admin setting and only ever mutates the SUPPLIED key's own config.
// Rate-limited via the dedicated apiKeyLookupLimiter (never the login limiter).
//
// Body: { key?, tokenSaver?: {rtk,toon,caveman,cavemanLevel,codexUsage},
//                overage?: {enabled, limit?} }

const CAVEMAN_LEVELS = new Set(["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"]);

function jsonError(message, status, headers) {
  return NextResponse.json({ error: message }, { status, headers });
}

async function extractBody(request) {
  let body = {};
  try { body = (await request.json()) || {}; } catch { body = {}; }
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  let key = m && m[1] ? m[1].trim() : "";
  if (!key) {
    const xKey = request.headers.get("x-api-key");
    if (xKey && xKey.trim()) key = xKey.trim();
  }
  if (!key && typeof body.key === "string") key = body.key.trim();
  return { key, body };
}

function sanitizeTokenSaver(input) {
  if (!input || typeof input !== "object") return { error: "Invalid tokenSaver payload" };
  const level = typeof input.cavemanLevel === "string" ? input.cavemanLevel : "full";
  if (!CAVEMAN_LEVELS.has(level)) return { error: "Invalid caveman level" };
  return {
    value: {
      rtk: input.rtk === true,
      toon: input.toon === true,
      caveman: input.caveman === true,
      cavemanLevel: level,
      codexUsage: input.codexUsage !== false,
    },
  };
}

export async function POST(request) {
  const ip = getClientIp(request);
  const limited = checkLookup(ip);
  if (limited.limited) {
    return jsonError("Too many requests. Try again later.", 429, { "Retry-After": String(limited.retryAfter) });
  }
  recordLookup(ip);

  const { key, body } = await extractBody(request);
  if (!key) return jsonError("API key required", 400);

  const brief = await getApiKeyBrief(key);
  if (!brief) {
    recordInvalid(ip);
    return jsonError("Invalid API key", 401);
  }

  const settings = await getSettings();
  const perms = resolveKeyHolderPermissions(brief.config, settings);
  const wantsTokenSaver = Object.prototype.hasOwnProperty.call(body, "tokenSaver");
  const wantsOverage = Object.prototype.hasOwnProperty.call(body, "overage");
  const wantsCustomInstruction = Object.prototype.hasOwnProperty.call(body, "customInstruction");
  if (!wantsTokenSaver && !wantsOverage && !wantsCustomInstruction) {
    return jsonError("Nothing to update", 400);
  }

  if (wantsTokenSaver) {
    if (!perms.tokenSaver) {
      return jsonError("Editing token saver is not permitted for this key", 403);
    }
    // Per-key token-saver only takes effect in individual mode (effectiveTokenSaver
    // ignores the per-key config under global mode). Reject the write instead of
    // silently saving a value that never applies.
    if (settings?.tokenSaverMode !== "individual") {
      return jsonError("Token saver is in global mode; per-key changes have no effect", 409);
    }
    const sanitized = sanitizeTokenSaver(body.tokenSaver);
    if (sanitized.error) return jsonError(sanitized.error, 400);
    const res = await updateApiKeyTokenSaverByValue(key, sanitized.value);
    if (!res) return jsonError("Invalid API key", 401);
    if (res.error) return jsonError(res.error, 400);
  }

  if (wantsOverage) {
    if (!perms.overage) {
      return jsonError("Editing overage is not permitted for this key", 403);
    }
    const ov = body.overage && typeof body.overage === "object" ? body.overage : null;
    if (!ov) return jsonError("Invalid overage payload", 400);
    const res = await updateApiKeyOverageByValue(key, {
      enabled: ov.enabled === true,
      limit: ov.limit,
    }, { selfService: true });
    if (!res) return jsonError("Invalid API key", 401);
    if (res.error) return jsonError(res.error, 400);
  }

  if (wantsCustomInstruction) {
    if (!perms.customInstruction) {
      return jsonError("Editing custom instruction is not permitted for this key", 403);
    }
    if (settings?.customInstructionMode !== "individual") {
      return jsonError("Custom instruction is in global mode; per-key changes have no effect", 409);
    }
    const ci = body.customInstruction && typeof body.customInstruction === "object" ? body.customInstruction : null;
    if (ci === null && body.customInstruction !== null) {
      return jsonError("Invalid custom instruction payload", 400);
    }
    const res = await updateApiKeyCustomInstructionByValue(key, ci || { enabled: false });
    if (!res) return jsonError("Invalid API key", 401);
    if (res.error) return jsonError(res.error, 400);
  }

  const updated = await getApiKeyBrief(key);
  return NextResponse.json({
    ok: true,
    tokenSaver: updated?.config?.tokenSaver || null,
    overage: updated?.usage?.overage || null,
    customInstruction: updated?.config?.customInstruction || null,
  });
}
