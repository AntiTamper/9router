const CODING_AGENT_PATTERNS = [
  { id: "claude-code", test: (ua, headers) => ua.includes("claude-cli") || ua.includes("claude-code") || headers["x-app"] === "cli" },
  { id: "roo-code", test: (ua) => ua.includes("roo-code") || ua.includes("roocode") },
  { id: "opencode", test: (ua) => ua.includes("opencode") || ua.includes("open-code") },
  { id: "openclaw", test: (ua) => ua.includes("openclaw") || ua.includes("open-claw") },
  { id: "hermes", test: (ua) => ua.includes("hermes") },
  { id: "kilo-code", test: (ua) => ua.includes("kilo-code") || ua.includes("kilocode") },
  { id: "cline", test: (ua) => ua.includes("cline") },
];

const KIMI_AGENT_HEADER_ALLOWLIST = [
  "user-agent",
  "x-app",
  "x-stainless-helper-method",
  "x-stainless-retry-count",
  "x-stainless-runtime-version",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-lang",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-timeout",
  "x-claude-code-session-id",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
];

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    normalized[String(key).toLowerCase()] = String(value);
  }
  return normalized;
}

export function detectKimiCodingAgent(headers = {}) {
  const normalized = normalizeHeaders(headers);
  const ua = (normalized["user-agent"] || "").toLowerCase();
  return CODING_AGENT_PATTERNS.find((agent) => agent.test(ua, normalized))?.id || null;
}

export function buildKimiCodingAgentHeaders(headers = {}) {
  const normalized = normalizeHeaders(headers);
  const agent = detectKimiCodingAgent(normalized);
  if (!agent) return { agent: null, headers: {} };

  const forwarded = {};
  for (const key of KIMI_AGENT_HEADER_ALLOWLIST) {
    const value = normalized[key];
    if (!value || value.length > 1024) continue;
    forwarded[key] = value;
  }
  return { agent, headers: forwarded };
}
