import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { customDomainEnabled: false, customDomain: "" },
}));

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => mocks.settings),
}));

function reqWithOrigin(origin) {
  return { headers: { get: (k) => (k.toLowerCase() === "origin" ? origin : null) } };
}

async function freshCors() {
  vi.resetModules();
  return await import("@/lib/cors.js");
}

describe("cors custom domain", () => {
  beforeEach(() => {
    mocks.settings = { customDomainEnabled: false, customDomain: "" };
  });

  it("always reflects loopback origins", async () => {
    const { getCorsHeaders } = await freshCors();
    const h = getCorsHeaders(reqWithOrigin("http://127.0.0.1:20128"));
    expect(h["Access-Control-Allow-Origin"]).toBe("http://127.0.0.1:20128");
  });

  it("does not reflect custom domain when disabled", async () => {
    mocks.settings = { customDomainEnabled: false, customDomain: "https://router.antitamper.id.vn" };
    const { getCorsHeaders } = await freshCors();
    // trigger background refresh, then wait a tick
    getCorsHeaders(reqWithOrigin("https://router.antitamper.id.vn"));
    await new Promise((r) => setTimeout(r, 10));
    const h = getCorsHeaders(reqWithOrigin("https://router.antitamper.id.vn"));
    expect(h["Access-Control-Allow-Origin"]).toBe("");
  });

  it("reflects custom domain when enabled", async () => {
    mocks.settings = { customDomainEnabled: true, customDomain: "https://router.antitamper.id.vn" };
    const { getCorsHeaders } = await freshCors();
    getCorsHeaders(reqWithOrigin("https://router.antitamper.id.vn"));
    await new Promise((r) => setTimeout(r, 10));
    const h = getCorsHeaders(reqWithOrigin("https://router.antitamper.id.vn"));
    expect(h["Access-Control-Allow-Origin"]).toBe("https://router.antitamper.id.vn");
  });

  it("rejects unrelated origins even when a custom domain is enabled", async () => {
    mocks.settings = { customDomainEnabled: true, customDomain: "https://router.antitamper.id.vn" };
    const { getCorsHeaders } = await freshCors();
    getCorsHeaders(reqWithOrigin("https://router.antitamper.id.vn"));
    await new Promise((r) => setTimeout(r, 10));
    const h = getCorsHeaders(reqWithOrigin("https://evil.example.com"));
    expect(h["Access-Control-Allow-Origin"]).toBe("");
  });
});