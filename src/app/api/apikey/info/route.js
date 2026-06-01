import { NextResponse } from "next/server";
import { getApiKeyBrief, getSettings, getComboByName } from "@/lib/localDb";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { resolveExposure, effectiveTokenSaver } from "@/lib/keyPolicy.js";
import { checkLock, recordFail, recordSuccess, getClientIp, checkGlobalLock, recordGlobalFail } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/apikey/info  body: { key }
// Public, key-as-login: returns a read-only brief for the supplied API key only.
// Rate-limited (per-IP + global backstop) to deter key enumeration.
export async function POST(request) {
  const ip = getClientIp(request);
  const globalLock = checkGlobalLock();
  if (globalLock.locked) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(globalLock.retryAfter) } });
  }
  const lock = checkLock(ip);
  if (lock.locked) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(lock.retryAfter) } });
  }

  let key;
  try {
    ({ key } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!key || typeof key !== "string") {
    return NextResponse.json({ error: "API key required" }, { status: 400 });
  }

  const brief = await getApiKeyBrief(key.trim());
  if (!brief) {
    recordGlobalFail();
    recordFail(ip);
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }
  recordSuccess(ip);

  const settings = await getSettings();
  const exposure = resolveExposure(brief.config, settings);
  const saver = effectiveTokenSaver(settings, brief.config);

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

  return NextResponse.json({
    name: brief.name,
    status: brief.status,
    isActive: brief.isActive,
    expiresAt: brief.expiresAt,
    createdAt: brief.createdAt,
    usage: brief.usage,
    tokenSaver: {
      mode: settings.tokenSaverMode || "global",
      rtk: saver.rtkEnabled,
      toon: saver.toonEnabled,
      caveman: saver.cavemanEnabled,
      cavemanLevel: saver.cavemanLevel,
      codexUsage: saver.codexUsageEnabled,
    },
    exposure,
    models: models.map((m) => ({ id: m.id, owned_by: m.owned_by, kind: m.kind || "llm" })),
  });
}