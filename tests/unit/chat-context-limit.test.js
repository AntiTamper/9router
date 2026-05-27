import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(),
  getApiKeyAccess: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  handleComboChat: vi.fn(),
  handleBypassRequest: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  getProjectIdForConnection: vi.fn(),
  log: {
    request: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    maskKey: vi.fn((key) => `${String(key).slice(0, 3)}...`),
  },
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  getApiKeyAccess: mocks.getApiKeyAccess,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: mocks.handleComboChat }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.handleBypassRequest }));
vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => mocks.log);
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: mocks.getProjectIdForConnection }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

describe("chat context-limit handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractApiKey.mockReturnValue(null);
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "kimi", model: "kimi-k2.6" });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "kimi-1",
      connectionName: "Kimi primary",
      apiKey: "sk-kimi",
      providerSpecificData: {},
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  });

  it("does not lock the selected account when upstream rejects over-context input", async () => {
    const response = new Response(JSON.stringify({
      error: { message: "[CONTEXT_LIMIT] token limit 262144 requested 315650" },
    }), { status: 400, headers: { "content-type": "application/json" } });

    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: "[CONTEXT_LIMIT] token limit 262144 requested 315650",
      response,
      skipAccountFallback: true,
    });

    const req = new Request("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "codex-cli" },
      body: JSON.stringify({ model: "kimi/kimi-k2.6", messages: [{ role: "user", content: "hi" }], stream: true }),
    });

    const res = await handleChat(req);

    expect(res.status).toBe(400);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
