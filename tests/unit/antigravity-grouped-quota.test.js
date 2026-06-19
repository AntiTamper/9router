import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

import { getAntigravityUsage, parseGroupedAntigravityQuota } from "../../open-sse/services/usage/google.js";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

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
  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

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

  it("keeps free-tier All Models groups separate from Claude/GPT", () => {
    const q = parseGroupedAntigravityQuota({
      groups: [{
        displayName: "All Models",
        buckets: [{ bucketId: "all-weekly", window: "weekly", remainingFraction: 1 }],
      }],
    });
    expect(q["all:weekly"]).toMatchObject({
      displayName: "All Models",
      family: "all",
      window: "weekly",
      remainingPercentage: 100,
    });
    expect(q["claude_gpt:weekly"]).toBeUndefined();
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

  it("does not fall back to model availability as quota when grouped quota is unavailable", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("loadCodeAssist")) {
        return jsonResponse({ currentTier: { name: "Pro" }, cloudaicompanionProject: "projects/test" });
      }
      if (href.includes("retrieveUserQuotaSummary")) {
        return jsonResponse({ error: { message: "quota unavailable" } }, 403);
      }
      if (href.includes("fetchAvailableModels")) {
        throw new Error("fetchAvailableModels must not be used for quota fallback");
      }
      throw new Error(`unexpected URL ${href}`);
    });

    const usage = await getAntigravityUsage("token", {});
    expect(usage).toMatchObject({ plan: "Pro", quotas: {} });
    expect(usage.message).toMatch(/quota not available|quota unavailable/i);
    const calledUrls = proxyAwareFetch.mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((url) => url.includes("fetchAvailableModels"))).toBe(false);
  });
});
