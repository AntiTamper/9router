import { describe, expect, it } from "vitest";
import {
  createBoundedTextAccumulator,
  readResponseTextBounded,
} from "../../open-sse/utils/boundedText.js";

describe("bounded text helpers", () => {
  it("keeps a preview while tracking original stream length", () => {
    const acc = createBoundedTextAccumulator(5);
    acc.append("abc");
    acc.append("defgh");

    expect(acc.snapshot()).toEqual({
      text: "abcde",
      originalLength: 8,
      truncated: true,
    });
  });

  it("rejects oversized response bodies", async () => {
    const res = new Response("abcdef");
    await expect(readResponseTextBounded(res, { limitBytes: 3, timeoutMs: 1000 }))
      .rejects.toMatchObject({ name: "BodyLimitError" });
  });
});
