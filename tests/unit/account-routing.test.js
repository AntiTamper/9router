import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ROUTING_MODE_OPTIONS,
  normalizeAccountRoutingMode,
} from "../../src/shared/utils/accountRouting.js";

describe("account routing modes", () => {
  it("exposes account cycling, quota, random, and one-by-one modes", () => {
    expect(ACCOUNT_ROUTING_MODE_OPTIONS.map((option) => option.id)).toEqual([
      "cycle",
      "highest",
      "lowest",
      "random",
      "one_by_one",
    ]);
    expect(ACCOUNT_ROUTING_MODE_OPTIONS.map((option) => option.label)).toEqual([
      "Cycle",
      "Highest quota",
      "Lowest quota",
      "Random",
      "1 by 1",
    ]);
  });

  it("keeps legacy routing settings compatible", () => {
    expect(normalizeAccountRoutingMode("default")).toBe("cycle");
    expect(normalizeAccountRoutingMode("round-robin")).toBe("cycle");
    expect(normalizeAccountRoutingMode("fill-first")).toBe("one_by_one");
    expect(normalizeAccountRoutingMode("one-by-one")).toBe("one_by_one");
    expect(normalizeAccountRoutingMode("highest-session-quota")).toBe("highest");
  });
});
