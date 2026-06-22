import { describe, expect, it } from "vitest";
import { __autoWarmupTest } from "@/shared/services/claudeAutoPing.js";

const { shouldWarmup, pickCodexWindows, shouldSkipWarmupCycle, warmupCycleKey, resolveCodexWarmupModel, buildCodexWarmupRequest } = __autoWarmupTest;

describe("provider auto warmup", () => {
  it("fires combined trigger for not-counting-down or out-of-quota", () => {
    const idle = { session: { used: 0, total: 100, resetAt: null } };
    const exhausted = { session: { used: 100, total: 100, resetAt: "2026-06-19T15:00:00.000Z" } };

    expect(shouldWarmup("not-counting-down-or-out-of-quota", idle, {}).should).toBe(true);
    expect(shouldWarmup("not-counting-down-or-out-of-quota", exhausted, {}).should).toBe(true);
  });

  it("retries no-reset idle warmup after the idle retry window", () => {
    const now = new Date("2026-06-19T10:00:00.000Z").getTime();
    const cycle = warmupCycleKey("codex", null);

    expect(shouldSkipWarmupCycle({}, cycle, null, now)).toBe(false);
    expect(shouldSkipWarmupCycle({ lastPingedCycle: cycle, lastPingOk: true, lastPingAt: new Date(now - 60_000).toISOString() }, cycle, null, now)).toBe(true);
    expect(shouldSkipWarmupCycle({ lastPingedCycle: cycle, lastPingOk: true, lastPingAt: new Date(now - 31 * 60_000).toISOString() }, cycle, null, now)).toBe(false);
  });

  it("does not retry the same reset-clock cycle", () => {
    const now = new Date("2026-06-19T10:00:00.000Z").getTime();
    const resetAt = "2026-06-19T15:00:00.000Z";
    const cycle = warmupCycleKey("claude", resetAt);

    expect(shouldSkipWarmupCycle({ lastPingedCycle: cycle, lastPingOk: true, lastPingAt: new Date(now - 2 * 60 * 60_000).toISOString() }, cycle, resetAt, now)).toBe(true);
  });

  it("retries failed warmup after the failed retry window", () => {
    const now = new Date("2026-06-19T10:00:00.000Z").getTime();
    const cycle = warmupCycleKey("antigravity", null);

    expect(shouldSkipWarmupCycle({ lastPingOk: false, lastPingAt: new Date(now - 60_000).toISOString() }, cycle, null, now)).toBe(true);
    expect(shouldSkipWarmupCycle({ lastPingOk: false, lastPingAt: new Date(now - 6 * 60_000).toISOString() }, cycle, null, now)).toBe(false);
  });

  it("uses Codex normal windows before review windows", () => {
    const normal = { remainingPercentage: 0 };
    const review = { remainingPercentage: 50 };
    expect(pickCodexWindows({ quotas: { session: normal, review_session: review } }).session).toBe(normal);
    expect(pickCodexWindows({ quotas: { review_session: review, review_weekly: review } }).session).toBe(review);
  });

  it("normalizes Codex warmup model to the upstream base id", () => {
    // UI suffix ids must collapse to the base id the /responses endpoint accepts.
    expect(resolveCodexWarmupModel("gpt-5.3-codex-low").model).toBe("gpt-5.3-codex");
    expect(resolveCodexWarmupModel("gpt-5.3-codex-xhigh").model).toBe("gpt-5.3-codex");
    expect(resolveCodexWarmupModel("gpt-5.3-codex-none").model).toBe("gpt-5.3-codex");
    expect(resolveCodexWarmupModel("gpt-5.3-codex").model).toBe("gpt-5.3-codex");
    // -review variants strip both markers.
    expect(resolveCodexWarmupModel("gpt-5.3-codex-low-review").model).toBe("gpt-5.3-codex");
    // Garbage falls back to a safe default.
    expect(resolveCodexWarmupModel("").model).toBe("gpt-5.3-codex");
    expect(resolveCodexWarmupModel(null).model).toBe("gpt-5.3-codex");
    // Configured effort is still reported for callers that want it.
    expect(resolveCodexWarmupModel("gpt-5.3-codex-high").configuredEffort).toBe("high");
  });

  it("builds a Codex warmup request accepted by the upstream responses endpoint", () => {
    const req = buildCodexWarmupRequest({
      id: "codex-account-1",
      accessToken: "token",
      providerSpecificData: { workspaceId: "workspace-1" },
    }, "gpt-5.3-codex-low-review");

    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer token");
    expect(req.headers.originator).toBe("codex_cli_rs");
    expect(req.headers.session_id).toBe("warmup-codex-account-1");
    expect(req.headers["chatgpt-account-id"]).toBe("workspace-1");
    expect(req.body.model).toBe("gpt-5.3-codex");
    expect(req.body.instructions).toContain("You are Codex");
    expect(req.body.reasoning).toEqual({ effort: "none", summary: "auto" });
    expect(req.body.stream).toBe(true);
    expect(req.body.store).toBe(false);
  });
});
