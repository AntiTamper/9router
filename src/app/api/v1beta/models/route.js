import { PROVIDER_MODELS } from "@/shared/constants/models";
import { corsOptionsResponse, getCorsHeaders } from "@/lib/cors.js";
import { getStaticContextWindow, getStaticMaxOutputTokens } from "open-sse/config/providerModels.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS(request) {
  return corsOptionsResponse(request);
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET(request) {
  try {
    // Collect all models from all providers
    const models = [];
    
    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        const ctxWindow = Number(model.contextWindow) || getStaticContextWindow(provider, model.id) || 128000;
        const maxOut = Number(model.maxOutputTokens) || getStaticMaxOutputTokens(provider, model.id) || 8192;
        models.push({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
          supportedGenerationMethods: ["generateContent"],
          inputTokenLimit: ctxWindow,
          outputTokenLimit: maxOut,
        });
      }
    }

    return Response.json({ models }, { headers: getCorsHeaders(request) });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}