// Validates + normalizes a structured API-key config from a request body.
// Mirrors the shape consumed by buildStructuredConfig in apiKeysRepo, but adds
// explicit error messages for the dashboard GUI. Returns { config } or { error }.
// All fields are optional; only provided sections are validated.

const EXPOSURE_MODES = new Set(["all", "combo"]);
const CAVEMAN_LEVELS = new Set(["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"]);
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

function posIntOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return undefined; // invalid sentinel
  return n;
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return undefined; // invalid sentinel
  return d.toISOString();
}

export function parseStructuredConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Invalid config" };
  }
  const out = {};

  if (raw.limits !== undefined) {
    if (!raw.limits || typeof raw.limits !== "object") return { error: "Invalid limits" };
    const limits = {};
    for (const k of ["daily", "weekly", "monthly", "hard"]) {
      const n = posIntOrNull(raw.limits[k]);
      if (n === undefined) return { error: `Invalid ${k} limit` };
      limits[k] = n;
    }
    out.limits = limits;
  }

  if (raw.dailyWindow !== undefined) {
    const dw = raw.dailyWindow;
    if (dw === null) {
      out.dailyWindow = null;
    } else if (dw && HHMM.test(dw.start || "") && HHMM.test(dw.end || "")) {
      out.dailyWindow = { start: dw.start, end: dw.end };
    } else {
      return { error: "Invalid daily window (use HH:MM)" };
    }
  }

  if (raw.availability !== undefined) {
    const av = raw.availability;
    if (av === null) {
      out.availability = null;
    } else if (av && typeof av === "object") {
      const from = isoOrNull(av.availableFrom);
      const until = isoOrNull(av.availableUntil);
      if (from === undefined) return { error: "Invalid availableFrom" };
      if (until === undefined) return { error: "Invalid availableUntil" };
      out.availability = (from || until) ? { availableFrom: from, availableUntil: until } : null;
    } else {
      return { error: "Invalid availability" };
    }
  }

  if (raw.tokenSaver !== undefined) {
    const ts = raw.tokenSaver;
    if (ts === null) {
      out.tokenSaver = null;
    } else if (ts && typeof ts === "object") {
      if (ts.cavemanLevel !== undefined && ts.cavemanLevel !== null && !CAVEMAN_LEVELS.has(ts.cavemanLevel)) {
        return { error: "Invalid cavemanLevel" };
      }
      out.tokenSaver = {
        rtk: ts.rtk === true,
        toon: ts.toon === true,
        caveman: ts.caveman === true,
        cavemanLevel: typeof ts.cavemanLevel === "string" ? ts.cavemanLevel : "full",
        codexUsage: ts.codexUsage !== false,
      };
    } else {
      return { error: "Invalid tokenSaver" };
    }
  }

  if (raw.exposure !== undefined) {
    const ex = raw.exposure;
    if (ex && EXPOSURE_MODES.has(ex.mode)) {
      if (ex.mode === "combo" && !String(ex.combo || "").trim()) {
        return { error: "Combo name required for combo exposure" };
      }
      out.exposure = { mode: ex.mode, combo: ex.mode === "combo" ? String(ex.combo).trim() : null };
    } else {
      return { error: "Invalid exposure" };
    }
  }

  if (raw.overage !== undefined) {
    const ov = raw.overage;
    if (ov === null || ov.enabled !== true) {
      out.overage = null;
    } else {
      const lim = posIntOrNull(ov.limit);
      if (lim === undefined || lim === null) return { error: "Overage limit required" };
      let window = null;
      if (ov.window && typeof ov.window === "object") {
        const from = isoOrNull(ov.window.availableFrom);
        const until = isoOrNull(ov.window.availableUntil || ov.window.expiresAt);
        if (from === undefined || until === undefined) return { error: "Invalid overage window" };
        window = (from || until) ? { availableFrom: from, availableUntil: until } : null;
      }
      out.overage = { enabled: true, limit: lim, window };
    }
  }

  if (raw.permissions !== undefined) {
    const pm = raw.permissions;
    if (pm === null) {
      out.permissions = { tokenSaver: null, overage: null };
    } else if (pm && typeof pm === "object") {
      const tri = (v) => (v === true || v === "on" ? true : v === false || v === "off" ? false : null);
      out.permissions = { tokenSaver: tri(pm.tokenSaver), overage: tri(pm.overage) };
    } else {
      return { error: "Invalid permissions" };
    }
  }

  return { config: out };
}

// Extracts top-level (non-config) key options shared by create + update:
// expiresAt | expiresInMs, autoDeleteExpired. Returns { options } or { error }.
export function parseKeyTimers(body = {}) {
  const options = {};
  if (Object.prototype.hasOwnProperty.call(body, "expiresInMs")) {
    if (body.expiresInMs === null || body.expiresInMs === "") {
      options.expiresAt = null;
    } else {
      const ms = Math.floor(Number(body.expiresInMs));
      if (!Number.isFinite(ms) || ms <= 0) return { error: "Invalid expiry duration" };
      options.expiresInMs = ms;
    }
  } else if (Object.prototype.hasOwnProperty.call(body, "expiresAt")) {
    const iso = isoOrNull(body.expiresAt);
    if (iso === undefined) return { error: "Invalid expiry time" };
    options.expiresAt = iso;
  }
  if (Object.prototype.hasOwnProperty.call(body, "autoDeleteExpired")) {
    options.autoDeleteExpired = body.autoDeleteExpired !== false;
  }
  return { options };
}