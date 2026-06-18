import { describe, expect, it } from "vitest";
import { isTerminalClientError, isLocalProxyFailure } from "open-sse/utils/error.js";

describe("isTerminalClientError", () => {
  it("flags OpenRouter moderation refusals as terminal (no account fallback)", () => {
    const msg = JSON.stringify({
      error: {
        message:
          'openai/gpt-oss-120b:free requires moderation on OpenInference. Your input was flagged for "illicit/violent". No credits were charged.',
        code: 403,
      },
    });
    expect(isTerminalClientError(403, msg)).toBe(true);
  });

  it("flags generic content-policy blocks", () => {
    expect(isTerminalClientError(400, "Your request violates our content policy")).toBe(true);
    expect(isTerminalClientError(400, "prohibited content detected")).toBe(true);
  });

  it("does NOT flag quota/auth/rate-limit errors (must still fall back)", () => {
    expect(isTerminalClientError(403, "You exceeded your current quota")).toBe(false);
    expect(isTerminalClientError(401, "Invalid authentication credentials")).toBe(false);
    expect(isTerminalClientError(429, "rate limit exceeded")).toBe(false);
    expect(isTerminalClientError(503, "service unavailable")).toBe(false);
  });

  it("returns false for empty/missing message", () => {
    expect(isTerminalClientError(403, "")).toBe(false);
    expect(isTerminalClientError(403, null)).toBe(false);
    expect(isTerminalClientError(403, undefined)).toBe(false);
  });

  it("is independent from isLocalProxyFailure (502 proxy issues)", () => {
    expect(isLocalProxyFailure(502, "invalid sse response")).toBe(true);
    expect(isTerminalClientError(502, "invalid sse response")).toBe(false);
  });
});
