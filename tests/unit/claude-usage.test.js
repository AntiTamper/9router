import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getClaudeUsage } from "../../open-sse/services/usage/claude.js";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const OK_USAGE = {
  five_hour: { utilization: 20, resets_at: "2026-06-18T21:00:00Z" },
  seven_day: { utilization: 14, resets_at: "2026-06-25T06:00:00Z" },
};

describe("Claude usage OAuth rate-limit handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses OAuth usage on success", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(OK_USAGE));
    const usage = await getClaudeUsage("tok-success-aaaaaaaa");
    expect(usage.plan).toBe("Claude Code");
    expect(usage.quotas["session (5h)"].remaining).toBe(80);
    expect(usage.quotas["weekly (7d)"].remaining).toBe(86);
    expect(usage.message).toBeUndefined();
  });

  it("on 429 returns a rate-limited message, NOT the admin-permissions legacy message", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: { type: "rate_limit_error" } }, 429, { "retry-after": "0" }),
    );
    const usage = await getClaudeUsage("tok-fresh-429-bbbbbbbb");
    // Must not hit legacy settings/org endpoints on 429.
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.message).toContain("rate-limited");
    expect(usage.message).not.toContain("admin permissions");
  });

  it("on 429 keeps showing last-known quota (stale) after a prior success", async () => {
    const tok = "tok-stale-cccccccc";
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(OK_USAGE));
    await getClaudeUsage(tok); // seed last-known
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: { type: "rate_limit_error" } }, 429),
    );
    const usage = await getClaudeUsage(tok);
    expect(usage.stale).toBe(true);
    // Real quota bars retained; no `message` so the UI does not short-circuit.
    expect(usage.message).toBeUndefined();
    expect(usage.quotas["weekly (7d)"].remaining).toBe(86);
  });

  it("during cooldown does not re-hit the network and returns rate-limited result", async () => {
    const tok = "tok-cooldown-dddddddd";
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: { type: "rate_limit_error" } }, 429),
    );
    await getClaudeUsage(tok); // triggers cooldown
    proxyAwareFetch.mockClear();
    const usage = await getClaudeUsage(tok);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(usage.message).toContain("rate-limited");
  });

  it("falls back to legacy path for non-429 errors", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403)) // oauth usage
      .mockResolvedValueOnce(jsonResponse({ plan: "team", organization_name: "Org" })); // settings (no org id)
    const usage = await getClaudeUsage("tok-legacy-eeeeeeee");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(usage.plan).toBe("team");
  });
});
