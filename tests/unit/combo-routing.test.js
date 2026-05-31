import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, resetComboRotation, handleComboChat } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

describe("combo disabled-model handling (#1561-style)", () => {
  it("returns a 503 with a clear message when no models are enabled", async () => {
    let called = 0;
    const res = await handleComboChat({
      body: {},
      models: [],
      handleSingleModel: async () => { called++; return new Response("x", { status: 200 }); },
      log: { info() {}, warn() {} },
      comboName: "premium-coding",
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.message).toBe('Combo "premium-coding" has no enabled models');
    expect(called).toBe(0);
  });

  it("still routes when enabled models remain", async () => {
    const tried = [];
    const res = await handleComboChat({
      body: {},
      models: ["glm/glm-5.1", "kr/claude-sonnet-4.5"],
      handleSingleModel: async (_body, modelStr) => {
        tried.push(modelStr);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      log: { info() {}, warn() {} },
      comboName: "premium-coding",
    });

    expect(res.status).toBe(200);
    expect(tried).toEqual(["glm/glm-5.1"]);
  });
});