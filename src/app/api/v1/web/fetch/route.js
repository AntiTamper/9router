import { handleFetch } from "@/sse/handlers/fetch.js";
import { corsOptionsResponse } from "@/lib/cors.js";

/**
 * Handle CORS preflight (origin allow-listed via cors.js, not wildcard).
 */
export async function OPTIONS(request) {
  return corsOptionsResponse(request);
}

/**
 * POST /v1/web/fetch - Web URL fetch/extract endpoint
 */
export async function POST(request) {
  return await handleFetch(request);
}
