import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { isKnownAccountRoutingMode, normalizeAccountRoutingMode } from "@/shared/utils/accountRouting";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};
const ALLOWED_CAVEMAN_LEVELS = new Set(["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"]);

function normalizeProviderStrategies(providerStrategies) {
  const normalized = {};
  for (const [providerId, override] of Object.entries(providerStrategies)) {
    if (override == null) {
      normalized[providerId] = override;
      continue;
    }
    normalized[providerId] = {
      ...override,
      ...(override.fallbackStrategy
        ? { fallbackStrategy: normalizeAccountRoutingMode(override.fallbackStrategy) }
        : {}),
    };
  }
  return normalized;
}

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    if (Object.prototype.hasOwnProperty.call(body, "cavemanLevel") && !ALLOWED_CAVEMAN_LEVELS.has(body.cavemanLevel)) {
      return NextResponse.json({ error: "Invalid cavemanLevel" }, { status: 400 });
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "fallbackStrategy") &&
      !isKnownAccountRoutingMode(body.fallbackStrategy)
    ) {
      return NextResponse.json({ error: "Invalid fallbackStrategy" }, { status: 400 });
    }
    if (Object.prototype.hasOwnProperty.call(body, "fallbackStrategy")) {
      body.fallbackStrategy = normalizeAccountRoutingMode(body.fallbackStrategy);
    }

    if (Object.prototype.hasOwnProperty.call(body, "providerStrategies")) {
      if (!body.providerStrategies || typeof body.providerStrategies !== "object" || Array.isArray(body.providerStrategies)) {
        return NextResponse.json({ error: "Invalid providerStrategies" }, { status: 400 });
      }
      for (const override of Object.values(body.providerStrategies)) {
        if (override == null) continue;
        if (typeof override !== "object" || Array.isArray(override)) {
          return NextResponse.json({ error: "Invalid providerStrategies" }, { status: 400 });
        }
        if (
          Object.prototype.hasOwnProperty.call(override, "fallbackStrategy") &&
          override.fallbackStrategy &&
          !isKnownAccountRoutingMode(override.fallbackStrategy)
        ) {
          return NextResponse.json({ error: "Invalid provider fallbackStrategy" }, { status: 400 });
        }
      }
      body.providerStrategies = normalizeProviderStrategies(body.providerStrategies);
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
