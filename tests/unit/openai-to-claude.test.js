/**
 * Unit tests for open-sse/translator/request/openai-to-claude.js
 *
 * Tests cover:
 *  - openaiToClaudeRequest() - OpenAI to Claude request translation
 *  - Response format handling (json_schema, json_object)
 */

import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

describe("openaiToClaudeRequest", () => {
  describe("response_format handling", () => {
    it("should inject JSON schema instructions for json_schema type", () => {
      const body = {
        messages: [{ role: "user", content: "What is 2+2?" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "math_response",
            schema: {
              type: "object",
              properties: {
                answer: { type: "number" },
                explanation: { type: "string" }
              },
              required: ["answer", "explanation"]
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      // Check that system prompt includes schema
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("\"answer\"");
      expect(systemText).toContain("\"explanation\"");
      expect(systemText).toContain("Respond ONLY with the JSON object");
      expect(systemText).not.toContain("You are Claude Code");
    });

    it("should inject basic JSON instructions for json_object type", () => {
      const body = {
        messages: [{ role: "user", content: "Give me a JSON object" }],
        response_format: {
          type: "json_object"
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("Respond ONLY with a JSON object");
    });

    it("should not modify system prompt when response_format is missing", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      expect(result.system).toBeUndefined();
    });

    it("should preserve existing system messages when adding response_format", () => {
      const body = {
        messages: [
          { role: "system", content: "You are a helpful math tutor." },
          { role: "user", content: "What is 2+2?" }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: {
              type: "object",
              properties: {
                result: { type: "number" }
              }
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should preserve original system message
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You are a helpful math tutor");
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).not.toContain("You are Claude Code");
    });
  });

  describe("tool_choice handling", () => {
    const baseTool = {
      type: "function",
      function: {
        name: "scan_project",
        description: "Scan project",
        parameters: { type: "object", properties: {} }
      }
    };

    it("should convert OpenAI string tool_choice into Claude object form", () => {
      const result = openaiToClaudeRequest("claude-sonnet-4.5", {
        messages: [{ role: "user", content: "scan" }],
        tools: [baseTool],
        tool_choice: "auto"
      }, false);

      expect(result.tool_choice).toEqual({ type: "auto" });
    });

    it("should convert OpenAI required tool_choice into Claude any form", () => {
      const result = openaiToClaudeRequest("claude-sonnet-4.5", {
        messages: [{ role: "user", content: "scan" }],
        tools: [baseTool],
        tool_choice: "required"
      }, false);

      expect(result.tool_choice).toEqual({ type: "any" });
    });

    it("should convert OpenAI function tool_choice into Claude tool form", () => {
      const result = openaiToClaudeRequest("claude-sonnet-4.5", {
        messages: [{ role: "user", content: "scan" }],
        tools: [baseTool],
        tool_choice: { type: "function", function: { name: "scan_project" } }
      }, false);

      expect(result.tool_choice).toEqual({ type: "tool", name: "scan_project" });
    });

    it("should normalize same-format Claude string tool_choice before dispatch", () => {
      const body = {
        messages: [{ role: "user", content: [{ type: "text", text: "scan" }] }],
        tools: [{ name: "scan_project", description: "Scan project", input_schema: { type: "object", properties: {} } }],
        tool_choice: "auto"
      };

      const result = prepareClaudeRequest(body, "claude");

      expect(result.tool_choice).toEqual({ type: "auto" });
    });

    it("should remove tool_choice when Claude tools are absent", () => {
      const body = {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tool_choice: "auto"
      };

      const result = prepareClaudeRequest(body, "claude");

      expect(result.tool_choice).toBeUndefined();
    });
  });
});

describe("openaiToClaudeResponse", () => {
  it("omits empty Read pages tool argument before emitting Claude input deltas", () => {
    const state = { toolCalls: new Map() };
    const chunk = {
      id: "chatcmpl-test",
      model: "gpt-test",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_read",
            function: {
              name: "Read",
              arguments: JSON.stringify({
                file_path: "/tmp/example.txt",
                offset: 0,
                limit: 120,
                pages: ""
              })
            }
          }]
        },
        finish_reason: "tool_calls"
      }]
    };

    const result = openaiToClaudeResponse(chunk, state);
    const inputDelta = result.find(event => event.delta?.type === "input_json_delta");

    expect(inputDelta).toBeDefined();
    expect(JSON.parse(inputDelta.delta.partial_json)).toEqual({
      file_path: "/tmp/example.txt",
      offset: 0,
      limit: 120
    });
  });
});
