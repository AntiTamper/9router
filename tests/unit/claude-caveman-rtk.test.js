import { describe, expect, it } from "vitest";
import { injectCaveman } from "open-sse/rtk/caveman.js";
import { compressMessages } from "open-sse/rtk/index.js";
import { CAVEMAN_PROMPTS } from "open-sse/rtk/cavemanPrompts.js";
import { FORMATS } from "open-sse/translator/formats.js";

const PROMPT_FULL = CAVEMAN_PROMPTS.full;

describe("caveman + RTK apply to Claude-format bodies", () => {
  it("caveman injects into Claude string system", () => {
    const body = { system: "You are helpful.", messages: [] };
    injectCaveman(body, FORMATS.CLAUDE, "full");
    expect(typeof body.system).toBe("string");
    expect(body.system).toContain("You are helpful.");
    expect(body.system).toContain(PROMPT_FULL);
  });

  it("caveman injects into Claude array system (respects cache_control ordering)", () => {
    const body = { system: [{ type: "text", text: "Base prompt", cache_control: { type: "ephemeral" } }], messages: [] };
    injectCaveman(body, FORMATS.CLAUDE, "full");
    expect(Array.isArray(body.system)).toBe(true);
    const texts = body.system.map((b) => b.text);
    expect(texts.some((t) => t.includes("Base prompt"))).toBe(true);
    expect(texts.some((t) => t === PROMPT_FULL)).toBe(true);
  });

  it("caveman injects when Claude body has no system at all", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectCaveman(body, FORMATS.CLAUDE, "full");
    expect(body.system).toBe(PROMPT_FULL);
  });

  it("RTK compresses Claude tool_result string content (git diff)", () => {
    const big = "diff --git a/x.js b/x.js\n@@ -1,2 +1,2 @@\n" + Array.from({ length: 300 }, (_, i) => "-old line " + i).join("\n") + "\n" + Array.from({ length: 300 }, (_, i) => "+new line " + i).join("\n");
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
      ],
    };
    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(body.messages[0].content[0].content.length).toBeLessThan(big.length);
  });

  it("RTK compresses Claude tool_result array text parts (git status)", () => {
    const big = "On branch main\n" + Array.from({ length: 300 }, (_, i) => " M src/file" + i + ".js").join("\n");
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: big }] }] },
      ],
    };
    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(body.messages[0].content[0].content[0].text.length).toBeLessThan(big.length);
  });
});
