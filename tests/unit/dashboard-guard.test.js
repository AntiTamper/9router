import { describe, it, expect } from "vitest";
import { proxy, __test__ } from "../../src/dashboardGuard.js";
import { createDashboardAuthToken } from "../../src/lib/auth/dashboardSession.js";

function request(pathname, headers = {}, cookies = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname },
    headers: normalizedHeaders,
    cookies: { get: (name) => cookies[name] ? { value: cookies[name] } : undefined },
    url: `http://localhost${pathname}`,
  };
}

describe("dashboard guard internal helpers", () => {
  it("extractApiKey prefers Bearer over x-api-key", () => {
    const req = request("/v1/chat/completions", {
      authorization: "Bearer sk-bearer",
      "x-api-key": "sk-xapi",
    });
    expect(__test__.extractApiKey(req)).toBe("sk-bearer");
  });

  it("extractApiKey falls back to x-api-key", () => {
    const req = request("/v1/chat/completions", { "x-api-key": "sk-xapi" });
    expect(__test__.extractApiKey(req)).toBe("sk-xapi");
  });

  it("isPublicLlmApi matches /v1 and /api/v1", () => {
    expect(__test__.isPublicLlmApi("/v1/chat/completions")).toBe(true);
    expect(__test__.isPublicLlmApi("/api/v1/chat/completions")).toBe(true);
    expect(__test__.isPublicLlmApi("/api/v1beta/models")).toBe(true);
    expect(__test__.isPublicLlmApi("/api/health")).toBe(false);
  });

  it("isLocalRequest accepts localhost", () => {
    expect(__test__.isLocalRequest(request("/", { host: "localhost:20128" }))).toBe(true);
  });

  it("isLocalRequest rejects remote host", () => {
    expect(__test__.isLocalRequest(request("/", { host: "router.example.com" }))).toBe(false);
  });
});

describe("dashboard guard proxy behavior", () => {
  it("returns 401 for remote public LLM API without key", async () => {
    const res = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("API key required for remote API access");
  });

  it("returns 401 for remote /v1beta without key", async () => {
    const res = await proxy(request("/v1beta/models", { host: "router.example.com" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("API key required for remote API access");
  });

  it("returns 403 for local-only route without CLI token", async () => {
    const res = await proxy(request("/api/mcp/filesystem/sse", { host: "localhost:20128" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route from loopback with dashboard auth token", async () => {
    const token = await createDashboardAuthToken();
    const res = await proxy(request(
      "/api/cli-tools/antigravity-mitm",
      { host: "127.0.0.1:20128", origin: "http://127.0.0.1:20128" },
      { auth_token: token },
    ));
    expect(res.status).not.toBe(403);
  });

  it("blocks local-only route from remote host even with dashboard auth token", async () => {
    const token = await createDashboardAuthToken();
    const res = await proxy(request(
      "/api/cli-tools/antigravity-mitm",
      { host: "router.example.com", origin: "https://router.example.com" },
      { auth_token: token },
    ));
    expect(res.status).toBe(403);
  });

  it("allows /api/health without auth", async () => {
    const res = await proxy(request("/api/health", { host: "router.example.com" }));
    expect(res.status).not.toBe(401);
  });
});
