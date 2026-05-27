export const ACCOUNT_ROUTING_MODES = ["cycle", "highest", "lowest", "random", "one_by_one"];

export const ACCOUNT_ROUTING_MODE_LABELS = {
  cycle: "Cycle",
  highest: "Highest quota",
  lowest: "Lowest quota",
  random: "Random",
  one_by_one: "1 by 1",
};

export const ACCOUNT_ROUTING_MODE_OPTIONS = ACCOUNT_ROUTING_MODES.map((id) => ({
  id,
  label: ACCOUNT_ROUTING_MODE_LABELS[id],
}));

const LEGACY_ACCOUNT_ROUTING_MODES = {
  default: "cycle",
  "fill-first": "one_by_one",
  "one-by-one": "one_by_one",
  "1-by-1": "one_by_one",
  "1 by 1": "one_by_one",
  "round-robin": "cycle",
  "highest-session-quota": "highest",
};

export function normalizeAccountRoutingMode(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (ACCOUNT_ROUTING_MODES.includes(raw)) return raw;
  return LEGACY_ACCOUNT_ROUTING_MODES[raw] || "cycle";
}

export function isKnownAccountRoutingMode(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return ACCOUNT_ROUTING_MODES.includes(raw) || Object.prototype.hasOwnProperty.call(LEGACY_ACCOUNT_ROUTING_MODES, raw);
}
