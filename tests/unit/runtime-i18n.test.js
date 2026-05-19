import { afterEach, describe, expect, it } from "vitest";
import {
  __processTextNodeForTests,
  __resetRuntimeI18nForTests,
  __setRuntimeI18nForTests,
} from "../../src/i18n/runtime.js";

function makeTextNode(value) {
  return {
    nodeValue: value,
    parentElement: {
      tagName: "span",
      hasAttribute: () => false,
      parentElement: null,
    },
  };
}

describe("runtime i18n dynamic text", () => {
  afterEach(() => {
    __resetRuntimeI18nForTests();
  });

  it("does not restore stale initial text when the default locale is active", () => {
    __setRuntimeI18nForTests("en");
    const node = makeTextNode("Stopped");

    __processTextNodeForTests(node);
    node.nodeValue = "Running";
    __processTextNodeForTests(node);

    expect(node.nodeValue).toBe("Running");
  });

  it("updates the tracked source when React changes translated text", () => {
    __setRuntimeI18nForTests("zh-CN", {
      Stopped: "已停止",
      Running: "运行中",
    });
    const node = makeTextNode("Stopped");

    __processTextNodeForTests(node);
    expect(node.nodeValue).toBe("已停止");

    node.nodeValue = "Running";
    __processTextNodeForTests(node);

    expect(node.nodeValue).toBe("运行中");
  });
});
