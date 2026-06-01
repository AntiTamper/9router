// Rate limiter for the PUBLIC /api/apikey/info lookup endpoint.
//
// Intentionally SEPARATE from loginLimiter: the public key-lookup endpoint must
// never be able to clear or trip the dashboard login lockout state (sharing it
// would let any key holder reset an admin brute-force lock, and would let a
// public attacker DoS admin login by tripping the global lock). In-memory only
// — a process restart clearing a public-lookup throttle is not a security
// regression (unlike admin login locks, which loginLimiter persists).
import { getClientIp } from "./loginLimiter.js";

export { getClientIp };

// Per-IP sliding request window (all requests, valid or not).
const PER_IP_WINDOW_MS = 60 * 1000;
const PER_IP_MAX = 30;
// Escalating lock after repeated INVALID keys from one IP (brute-force guard).
const INVALID_WINDOW_MS = 5 * 60 * 1000;
const INVALID_MAX = 20;
const INVALID_LOCK_MS = 5 * 60 * 1000;
// Global backstop independent of client IP (defeats source-IP rotation).
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX = 300;
const GLOBAL_LOCK_MS = 60 * 1000;
const MAX_ENTRIES = 4096;

const ipState = new Map(); // ip -> { reqs:[ts], invalids:[ts], lockUntil }
let globalReqs = [];
let globalLockUntil = 0;

function now() { return Date.now(); }

function prune(arr, windowMs, ts) {
  return arr.filter((t) => ts - t < windowMs);
}

function pruneEntries() {
  if (ipState.size <= MAX_ENTRIES) return;
  // Drop oldest-inserted entries first.
  const overflow = ipState.size - MAX_ENTRIES;
  let i = 0;
  for (const k of ipState.keys()) {
    ipState.delete(k);
    if (++i >= overflow) break;
  }
}

function entry(ip) {
  let e = ipState.get(ip);
  if (!e) { e = { reqs: [], invalids: [], lockUntil: 0 }; ipState.set(ip, e); }
  return e;
}

// Call at the start of every request. Returns { limited, retryAfter }.
export function checkLookup(ip) {
  const ts = now();
  if (globalLockUntil > ts) {
    return { limited: true, retryAfter: Math.ceil((globalLockUntil - ts) / 1000) };
  }
  const e = ipState.get(ip);
  if (e) {
    if (e.lockUntil > ts) {
      return { limited: true, retryAfter: Math.ceil((e.lockUntil - ts) / 1000) };
    }
    e.reqs = prune(e.reqs, PER_IP_WINDOW_MS, ts);
    if (e.reqs.length >= PER_IP_MAX) {
      return { limited: true, retryAfter: Math.ceil(PER_IP_WINDOW_MS / 1000) };
    }
  }
  return { limited: false };
}

// Count one accepted request (after the rate check passes).
export function recordLookup(ip) {
  const ts = now();
  const e = entry(ip);
  e.reqs = prune(e.reqs, PER_IP_WINDOW_MS, ts);
  e.reqs.push(ts);
  globalReqs = prune(globalReqs, GLOBAL_WINDOW_MS, ts);
  globalReqs.push(ts);
  if (globalReqs.length >= GLOBAL_MAX) {
    globalLockUntil = ts + GLOBAL_LOCK_MS;
    globalReqs = [];
  }
  pruneEntries();
}

// Count one INVALID-key attempt; escalates to a per-IP lock when abused.
export function recordInvalid(ip) {
  const ts = now();
  const e = entry(ip);
  e.invalids = prune(e.invalids, INVALID_WINDOW_MS, ts);
  e.invalids.push(ts);
  if (e.invalids.length >= INVALID_MAX) {
    e.lockUntil = ts + INVALID_LOCK_MS;
    e.invalids = [];
  }
}