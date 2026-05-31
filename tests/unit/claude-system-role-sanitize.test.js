/**
 * Regression test for #1580:
 * Anthropic rejects role:"system" inside messages[]. In passthrough mode the
 * body is sent untranslated, so system messages must be lifted into the
 * top-level `system` field for Claude / anthropic-compatible providers.
 */

import { describe, it, expect } from "vitest";
import { sanitizeSystemRole } from "../../open-sse/translator/helpers/claudeHelper.js";

describe("sanitizeSystemRole", () => {
  it("moves a string system message into top-level system", () => {
    const out = sanitizeSystemRole({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out.messages.every((m) => m.role !== "system")).toBe(true);
    expect(Array.isArray(out.system)).toBe(true);
    expect(out.system[0].text).toBe("You are helpful.");
    expect(out.messages).toHaveLength(1);
  });

  it("merges multiple system messages and preserves existing system", () => {
    const out = sanitizeSystemRole({
      system: "Base.",
      messages: [
        { role: "system", content: "One." },
        { role: "system", content: [{ type: "text", text: "Two." }] },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out.system[0].text).toBe("Base.\nOne.\nTwo.");
    expect(out.messages).toHaveLength(1);
  });

  it("returns body unchanged when no system messages present", () => {
    const input = { messages: [{ role: "user", content: "Hi" }] };
    const out = sanitizeSystemRole(input);
    expect(out).toBe(input);
  });

  it("is safe when messages missing", () => {
    const input = { system: "x" };
    expect(sanitizeSystemRole(input)).toBe(input);
  });
});