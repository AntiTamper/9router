import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function normalizeTools(tools) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    stream: true,
  };
  executor.transformRequest("gpt-5.5", body, true, { connectionId: "test-codex-tools", providerSpecificData: {} });
  return body.tools;
}

describe("CodexExecutor tool normalization", () => {
  it("preserves Responses-native hosted and discovery tools", () => {
    const tools = normalizeTools([
      { type: "tool_search", execution: "sync", description: "Discover tools", parameters: { type: "object", properties: {} } },
      { type: "web_search", search_context_size: "medium" },
      { type: "image_generation", size: "1024x1024" },
      { type: "mcp", server_label: "docs", server_url: "https://example.com/mcp" },
      { type: "local_shell" },
      { type: "code_interpreter", container: { type: "auto" } },
    ]);

    expect(tools.map((tool) => tool.type)).toEqual(["tool_search", "web_search", "image_generation", "mcp", "local_shell", "code_interpreter"]);
  });

  it("preserves custom freeform tools with grammar payloads", () => {
    const tools = normalizeTools([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);

    expect(tools).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);
  });
});
