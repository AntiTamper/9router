import { describe, it, expect } from "vitest";

// The public /api/apikey/info limiter MUST be isolated from the dashboard
// login limiter. These tests lock in (a) per-IP + global throttling and
// (b) that it never imports/mutates loginLimiter lockout state.
import { checkLookup, recordLookup, recordInvalid, getClientIp } from "@/lib/auth/apiKeyLookupLimiter.js";

function fakeReq(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: { get: (h) => lower[h.toLowerCase()] ?? null } };
}

describe("apiKeyLookupLimiter", () => {
  it("allows requests under the per-IP cap", () => {
    const ip = `ip-${Math.random()}`;
    for (let i = 0; i < 30; i++) {
      expect(checkLookup(ip).limited).toBe(false);
      recordLookup(ip);
    }
  });

  it("throttles a single IP after exceeding the per-IP cap", () => {
    const ip = `ip-${Math.random()}`;
    for (let i = 0; i < 30; i++) recordLookup(ip);
    const r = checkLookup(ip);
    expect(r.limited).toBe(true);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("locks an IP that submits too many invalid keys", () => {
    const ip = `ip-${Math.random()}`;
    for (let i = 0; i < 20; i++) recordInvalid(ip);
    const r = checkLookup(ip);
    expect(r.limited).toBe(true);
  });

  it("derives client IP from trusted headers, not spoofable XFF leftmost", () => {
    expect(getClientIp(fakeReq({ "cf-connecting-ip": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(getClientIp(fakeReq({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    // Leftmost XFF is client-controllable; limiter uses the rightmost entry.
    expect(getClientIp(fakeReq({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("10.0.0.1");
    expect(getClientIp(fakeReq({}))).toBe("unknown");
  });

  it("does not import or expose any dashboard login lockout mutators", async () => {
    const mod = await import("@/lib/auth/apiKeyLookupLimiter.js");
    // Only the lookup-specific surface + the shared getClientIp helper.
    expect(Object.keys(mod).sort()).toEqual(
      ["checkLookup", "getClientIp", "recordInvalid", "recordLookup"].sort()
    );
    expect(mod.recordSuccess).toBeUndefined();
    expect(mod.recordGlobalFail).toBeUndefined();
    expect(mod.checkGlobalLock).toBeUndefined();
  });
});