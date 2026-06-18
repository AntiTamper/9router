import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPlugin: vi.fn(() => ({ name: "browsermcp" })),
  registerSession: vi.fn(() => "sid-1"),
  unregisterSession: vi.fn(),
}));

vi.mock("@/lib/mcp/stdioSseBridge", () => mocks);

describe("/api/mcp/[plugin]/sse cleanup", () => {
  beforeEach(() => {
    mocks.findPlugin.mockClear();
    mocks.registerSession.mockClear();
    mocks.unregisterSession.mockClear();
  });

  it("unregisters the bridge session when the request aborts", async () => {
    const { GET } = await import("../../src/app/api/mcp/[plugin]/sse/route.js");
    const abort = new AbortController();
    const res = await GET(
      new Request("http://localhost/api/mcp/browsermcp/sse", { signal: abort.signal }),
      { params: Promise.resolve({ plugin: "browsermcp" }) },
    );
    const reader = res.body.getReader();

    await reader.read();
    expect(mocks.registerSession).toHaveBeenCalledWith("browsermcp", expect.any(Function));

    abort.abort();
    await Promise.resolve();

    expect(mocks.unregisterSession).toHaveBeenCalledWith("browsermcp", "sid-1");

    await reader.cancel();
  });
});
