import { describe, it, expect } from "vitest";
import {
  getClientIp,
  checkGlobalLock,
  recordGlobalFail,
  checkLock,
  recordFail,
  recordSuccess,
} from "../../src/lib/auth/loginLimiter.js";

function req(headers) {
  return { headers: new Headers(headers) };
}

describe("loginLimiter getClientIp (anti-spoof)", () => {
  it("prefers cf-connecting-ip over x-forwarded-for", () => {
    const ip = getClientIp(req({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "9.9.9.9, 5.6.7.8",
      "x-real-ip": "8.8.8.8",
    }));
    expect(ip).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when no cf header", () => {
    const ip = getClientIp(req({
      "x-forwarded-for": "9.9.9.9, 5.6.7.8",
      "x-real-ip": "8.8.8.8",
    }));
    expect(ip).toBe("8.8.8.8");
  });

  it("uses rightmost (closest-proxy) XFF entry, not spoofable leftmost", () => {
    const ip = getClientIp(req({ "x-forwarded-for": "9.9.9.9, 5.6.7.8" }));
    expect(ip).toBe("5.6.7.8");
  });

  it("returns unknown with no proxy headers", () => {
    expect(getClientIp(req({}))).toBe("unknown");
  });
});

describe("loginLimiter per-IP lockout (DB-absent fallback)", () => {
  it("locks an IP after MAX_FAILS and reports retryAfter, no DB needed", () => {
    const ip = "203.0.113.7";
    recordSuccess(ip);
    expect(checkLock(ip).locked).toBe(false);
    let last;
    for (let i = 0; i < 5; i++) last = recordFail(ip);
    expect(last.remainingBeforeLock).toBe(5);
    const lock = checkLock(ip);
    expect(lock.locked).toBe(true);
    expect(lock.retryAfter).toBeGreaterThan(0);
    recordSuccess(ip);
    expect(checkLock(ip).locked).toBe(false);
  });
});
describe("loginLimiter global backstop", () => {
  it("trips a global lock after enough total fails regardless of IP", () => {
    expect(checkGlobalLock().locked).toBe(false);
    for (let i = 0; i < 50; i++) recordGlobalFail();
    const lock = checkGlobalLock();
    expect(lock.locked).toBe(true);
    expect(lock.retryAfter).toBeGreaterThan(0);
  });
});