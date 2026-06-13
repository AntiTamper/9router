import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { pingModelByKind } from "@/app/api/models/test/ping";

async function resolveDynamicKiroModels(connection) {
  const result = await resolveKiroModels({
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    providerSpecificData: connection.providerSpecificData || {},
  }, { log: console });
  return (result?.models || []).map((model) => ({
    id: model.id,
    name: model.name || model.id,
  }));
}

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId — used only to resolve provider + model list.
 * Actual requests go through /api/v1/chat/completions (open-sse handles everything).
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const providerId = connection.provider;
    const isCompatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias);

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    if (providerId === "kiro") {
      try {
        const liveModels = await resolveDynamicKiroModels(connection);
        if (liveModels.length > 0) models = liveModels;
      } catch (error) {
        console.log("Kiro live model test list failed, falling back to static:", error?.message || error);
      }
    }

    // Compatible providers: fetch live model list
    if (isCompatible && models.length === 0) {
      try {
        const modelsRes = await fetch(`${baseUrl}/api/providers/${id}/models`);
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch { /* fallback to empty */ }
    }

    if (models.length === 0) {
      return NextResponse.json({ error: "No models configured for this provider" }, { status: 400 });
    }


    // Warm up with first model to trigger token refresh (if needed) before parallel calls.
    // This prevents race condition where multiple requests concurrently refresh the same token.
    const [first, ...rest] = models;
    const firstResult = await pingModelByKind(`${alias}/${first.id}`, first.type || "llm", baseUrl);
    const results = [{ modelId: first.id, name: first.name || first.id, ...firstResult }];

    if (rest.length > 0) {
      const restResults = await Promise.all(
        rest.map(async (model) => {
          const result = await pingModelByKind(`${alias}/${model.id}`, model.type || "llm", baseUrl);
          return { modelId: model.id, name: model.name || model.id, ...result };
        })
      );
      results.push(...restResults);
    }

    return NextResponse.json({ provider: providerId, connectionId: id, results });
  } catch (error) {
    console.log("Error testing models:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
