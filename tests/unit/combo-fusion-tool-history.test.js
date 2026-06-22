import { describe, expect, it, vi } from "vitest";

import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function okResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fusion combo tool history", () => {
  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));

    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }] },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" },
        ],
        tools: [{ type: "function" }],
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([, , isPanel]) => isPanel === true);
    expect(panelCalls).toHaveLength(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages).toHaveLength(4);
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
    }

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    expect(judgeCall[0].messages[1].tool_calls).toBeDefined();
    expect(judgeCall[0].messages[2].role).toBe("tool");
  });
});
