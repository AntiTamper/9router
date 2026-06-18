import { describe, it, expect } from "vitest";
import { parseGroupedAntigravityQuota } from "../../open-sse/services/usage/google.js";

// Real captured response shape from the Antigravity IDE grouped-quota endpoint.
const SAMPLE = {
  response: {
    groups: [
      {
        displayName: "Gemini Models",
        description: "Models within this group: Gemini Flash, Gemini Pro",
        buckets: [
          { bucketId: "gemini-weekly", displayName: "Weekly Limit", window: "weekly", remainingFraction: 0.9687833, resetTime: "2026-06-19T21:21:54Z" },
          { bucketId: "gemini-5h", displayName: "Five Hour Limit", window: "5h", remainingFraction: 1, resetTime: "2026-06-18T21:41:07Z" },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", displayName: "Weekly Limit", window: "weekly", remainingFraction: 0.85833454, resetTime: "2026-06-25T06:27:56Z" },
          { bucketId: "3p-5h", displayName: "Five Hour Limit", window: "5h", remainingFraction: 1, resetTime: "2026-06-18T21:41:07Z" },
        ],
      },
    ],
  },
};

describe("parseGroupedAntigravityQuota", () => {
  it("maps the real grouped response to per-family weekly + five_hour quotas", () => {
    const q = parseGroupedAntigravityQuota(SAMPLE);
    expect(Math.round(q["gemini:weekly"].remainingPercentage)).toBe(97);
    expect(q["gemini:weekly"].window).toBe("weekly");
    expect(q["gemini:weekly"].family).toBe("gemini");
    expect(Math.round(q["gemini:five_hour"].remainingPercentage)).toBe(100);
    expect(Math.round(q["claude_gpt:weekly"].remainingPercentage)).toBe(86);
    expect(q["claude_gpt:weekly"].family).toBe("claude_gpt");
    expect(Math.round(q["claude_gpt:five_hour"].remainingPercentage)).toBe(100);
  });

  it("tolerates a bare {groups:[...]} payload (no response wrapper)", () => {
    const q = parseGroupedAntigravityQuota({ groups: SAMPLE.response.groups });
    expect(Math.round(q["gemini:weekly"].remainingPercentage)).toBe(97);
  });

  it("clamps out-of-range / missing fractions", () => {
    const q = parseGroupedAntigravityQuota({
      groups: [{ displayName: "Gemini Models", buckets: [
        { window: "weekly", remainingFraction: 1.5 },
        { window: "5h" },
      ] }],
    });
    expect(q["gemini:weekly"].remainingPercentage).toBe(100);
    expect(q["gemini:five_hour"].remainingPercentage).toBe(0);
  });

  it("returns an empty object for empty / malformed input", () => {
    expect(parseGroupedAntigravityQuota(null)).toEqual({});
    expect(parseGroupedAntigravityQuota({})).toEqual({});
    expect(parseGroupedAntigravityQuota({ response: { groups: [] } })).toEqual({});
  });
});
