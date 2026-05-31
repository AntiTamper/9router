/**
 * CORS helper for LLM API routes.
 * Reflects origin only for loopback, configured tunnel/tailscale origins,
 * or an enabled custom domain.
 */

import { getSettings } from "@/lib/db/repos/settingsRepo.js";

const ALLOWED_ORIGINS = new Set(["localhost", "127.0.0.1", "::1"]);

// Lazily refreshed snapshot of enabled custom-domain hosts. Kept module-level
// so getCorsHeaders can stay synchronous for hot API paths. Refresh is fired in
// the background (non-blocking) with a short TTL; default-disabled => empty set.
let allowedCustomHosts = new Set();
let lastRefreshAt = 0;
let refreshInflight = null;
const REFRESH_TTL_MS = 30_000;

function hostFromUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function refreshAllowedCustomHosts() {
  if (refreshInflight) return refreshInflight;
  refreshInflight = getSettings()
    .then((settings) => {
      const next = new Set();
      if (settings?.customDomainEnabled === true) {
        const host = hostFromUrl(settings.customDomain);
        if (host) next.add(host);
      }
      allowedCustomHosts = next;
      lastRefreshAt = Date.now();
    })
    .catch(() => { /* keep previous snapshot on error */ })
    .finally(() => { refreshInflight = null; });
  return refreshInflight;
}

function maybeScheduleRefresh() {
  if (Date.now() - lastRefreshAt > REFRESH_TTL_MS) {
    void refreshAllowedCustomHosts();
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (ALLOWED_ORIGINS.has(hostname)) return true;
    if (allowedCustomHosts.has(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function getCorsHeaders(request) {
  maybeScheduleRefresh();
  const origin = request.headers.get("origin") || "";
  const allowOrigin = isAllowedOrigin(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

export function corsOptionsResponse(request) {
  return new Response(null, { headers: getCorsHeaders(request) });
}

export function corsJsonResponse(body, init = {}, request) {
  return Response.json(body, {
    ...init,
    headers: { ...init.headers, ...getCorsHeaders(request) },
  });
}