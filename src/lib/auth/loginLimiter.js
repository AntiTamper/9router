// Progressive lockout for dashboard login. In-memory fast path, with active
// lockouts persisted to the DB (_meta) so a process restart / deploy cannot be
// used to clear an active lock. Failed-but-not-locked counters stay in-memory.
import { getAdapterSync } from "../db/driver.js";

const LOCKOUT_META_KEY = "loginLockouts";
let hydrated = false;

function dbOrNull() {
  try { return getAdapterSync(); } catch { return null; }
}

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset
const MAX_ATTEMPT_ENTRIES = 2048;

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt }

function now() { return Date.now(); }

function hydrateLocks() {
  if (hydrated) return;
  const db = dbOrNull();
  if (!db) return; // adapter not ready yet; retry on a later call
  hydrated = true;
  try {
    const row = db.get(`SELECT value FROM _meta WHERE key = ?`, [LOCKOUT_META_KEY]);
    if (!row?.value) return;
    const arr = JSON.parse(row.value);
    if (!Array.isArray(arr)) return;
    const ts = now();
    for (const item of arr) {
      const ip = item?.[0];
      const e = item?.[1];
      if (ip && e?.lockUntil && e.lockUntil > ts) {
        attempts.set(ip, { fails: 0, lockUntil: e.lockUntil, lockLevel: e.lockLevel || 0, lastFailAt: ts });
      }
    }
  } catch { /* ignore corrupt/missing persisted state */ }
}

function persistLocks() {
  const db = dbOrNull();
  if (!db) return;
  try {
    const ts = now();
    const active = [];
    for (const [ip, e] of attempts) {
      if (e.lockUntil && e.lockUntil > ts) active.push([ip, { lockUntil: e.lockUntil, lockLevel: e.lockLevel }]);
    }
    db.run(
      `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [LOCKOUT_META_KEY, JSON.stringify(active)],
    );
  } catch { /* best-effort persistence */ }
}

function pruneAttempts(ts = now()) {
  for (const [ip, entry] of attempts) {
    if (!entry?.lastFailAt || (ts - entry.lastFailAt > FAIL_WINDOW_MS && (!entry.lockUntil || ts >= entry.lockUntil))) {
      attempts.delete(ip);
    }
  }
  while (attempts.size > MAX_ATTEMPT_ENTRIES) {
    const oldestKey = attempts.keys().next().value;
    if (!oldestKey) break;
    attempts.delete(oldestKey);
  }
}

function getEntry(ip) {
  pruneAttempts();
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLock(ip) {
  hydrateLocks();
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(ip) {
  hydrateLocks();
  pruneAttempts();
  const e = getEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  let lockedNow = false;
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
    lockedNow = true;
  }
  attempts.set(ip, e);
  pruneAttempts();
  if (lockedNow) persistLocks();
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip) {
  const wasLocked = !!attempts.get(ip)?.lockUntil;
  attempts.delete(ip);
  if (wasLocked) persistLocks();
}

// Global backstop independent of client IP. Defends against X-Forwarded-For /
// source-IP rotation: even if an attacker forges a fresh IP per request, total
// failed logins across ALL buckets are capped within a sliding window.
const GLOBAL_FAIL_WINDOW_MS = 5 * 60 * 1000; // 5m sliding window
const GLOBAL_MAX_FAILS = 50; // failed logins (any source) before global slowdown
const GLOBAL_LOCK_MS = 60 * 1000; // 1m global slowdown when tripped
let globalFails = []; // recent fail timestamps
let globalLockUntil = 0;

function pruneGlobal(ts = now()) {
  if (globalFails.length) {
    globalFails = globalFails.filter((t) => ts - t < GLOBAL_FAIL_WINDOW_MS);
  }
}

export function checkGlobalLock() {
  const ts = now();
  if (globalLockUntil > ts) {
    return { locked: true, retryAfter: Math.ceil((globalLockUntil - ts) / 1000) };
  }
  return { locked: false };
}

export function recordGlobalFail() {
  const ts = now();
  pruneGlobal(ts);
  globalFails.push(ts);
  if (globalFails.length >= GLOBAL_MAX_FAILS) {
    globalLockUntil = ts + GLOBAL_LOCK_MS;
    globalFails = [];
  }
}

export function getClientIp(request) {
  // Behind a trusted proxy/tunnel (Cloudflare), CF-Connecting-IP is set by the
  // edge and cannot be spoofed by the client. Prefer it, then x-real-ip. Never
  // trust the client-controllable leftmost X-Forwarded-For; fall back only to
  // the rightmost (closest-proxy) entry.
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "unknown";
}
