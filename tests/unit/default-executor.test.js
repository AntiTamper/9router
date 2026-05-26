import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("DefaultExecutor", () => {
  it("downgrades json_schema response_format for openai-compatible providers", () => {
    const executor = new DefaultExecutor("openai-compatible-local");

    const transformed = executor.transformRequest("local-model", {
      model: "local-model",
      messages: [{ role: "user", content: "return json" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"]
          }
        }
      }
    });

    expect(transformed.response_format).toEqual({ type: "json_object" });
    expect(transformed.messages[0].role).toBe("system");
    expect(transformed.messages[0].content).toContain("valid JSON");
    expect(transformed.messages[0].content).toContain("\"answer\"");
    expect(transformed.messages[1]).toEqual({ role: "user", content: "return json" });
  });

  it("does not downgrade json_schema response_format for first-party providers", () => {
    const executor = new DefaultExecutor("kimi");

    const transformed = executor.transformRequest("kimi-k2.6", {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "return json" }],
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object" } }
      }
    });

    expect(transformed.response_format.type).toBe("json_schema");
    expect(transformed.messages).toEqual([{ role: "user", content: "return json" }]);
  });
});
