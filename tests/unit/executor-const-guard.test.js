// A5 (cases #7/#9/#10): lock hardcode->config no-op values.
import { describe, it, expect } from "vitest";
import {
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
  ANTHROPIC_API_VERSION,
} from "../../open-sse/providers/shared.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";
import mimoFree from "../../open-sse/providers/registry/mimo-free.js";
import opencode from "../../open-sse/providers/registry/opencode.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { resolveAntigravityImageConfig } from "../../open-sse/handlers/imageProviders/antigravity.js";

describe("compat base URLs / version", () => {
  it("OPENAI_COMPAT_BASE", () => {
    expect(OPENAI_COMPAT_BASE).toBe("https://api.openai.com/v1");
  });
  it("ANTHROPIC_COMPAT_BASE", () => {
    expect(ANTHROPIC_COMPAT_BASE).toBe("https://api.anthropic.com/v1");
  });
  it("ANTHROPIC_API_VERSION", () => {
    expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
  });
});

describe("default token limits", () => {
  it("max/min", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(64000);
    expect(DEFAULT_MIN_TOKENS).toBe(32000);
  });
});

describe("provider baseUrl const (full path, no trailing slash)", () => {
  it("mimo-free full path", () => {
    expect(mimoFree.transport.baseUrl).toBe("https://api.xiaomimimo.com/api/free-ai/openai/chat");
  });
  it("opencode no trailing slash", () => {
    expect(opencode.transport.baseUrl).toBe("https://opencode.ai");
  });
});

describe("antigravity retry (429=3, 503=3)", () => {
  it("429 attempts = 3", () => {
    expect(antigravity.transport.retry["429"].attempts).toBe(3);
  });
  it("503 attempts = 3", () => {
    expect(antigravity.transport.retry["503"].attempts).toBe(3);
  });

  it("does not veto configured non-429 retries", async () => {
    const executor = new AntigravityExecutor();
    const response = new Response("temporary", { status: 503 });
    await expect(executor.computeRetryDelay(response, 1)).resolves.toBeNull();
  });
});


describe("antigravity image request config", () => {
  it("maps OpenAI image size to Antigravity aspectRatio", () => {
    expect(resolveAntigravityImageConfig({ size: "1792x1024" })).toEqual({ aspectRatio: "16:9" });
    expect(resolveAntigravityImageConfig({ size: "1024x1792" })).toEqual({ aspectRatio: "9:16" });
    expect(resolveAntigravityImageConfig({ size: "1536x1024" })).toEqual({ aspectRatio: "3:2" });
    expect(resolveAntigravityImageConfig({ aspect_ratio: "4:3" })).toEqual({ aspectRatio: "4:3" });
  });

  it("passes adapter imageConfig through executor envelope", () => {
    const executor = new AntigravityExecutor();
    const out = executor.transformRequest("gemini-3.1-flash-image", {
      imageConfig: { aspectRatio: "16:9" },
      contents: [{ role: "user", parts: [{ text: "draw" }] }],
    }, false, { accessToken: "tok", connectionId: "ag-image-test" });

    expect(out.requestType).toBe("image_gen");
    expect(out.request.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9" });
    expect(out.request.contents[0].parts[0].text).toBe("draw");
  });
});
