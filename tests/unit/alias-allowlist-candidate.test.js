// A client that calls a MODEL ALIAS must not be refused with
// `Model "…" is not available. Only models listed in /v1/models can be used.`
//
// Why it happened: the alias resolves to a target id, the target id's provider
// alias expands to the long provider id (`za` → `zai`), and the catalog is keyed
// by the *short* form (`za/glm-5.3-flash`). The candidate list only ever held
// `zai/glm-5.3-flash` + the raw client string, so the allowlist probe missed and
// a perfectly valid alias 404'd even though /v1/models lists the target.
//
// The fix probes the alias target as a third candidate. This test pins that.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  extractApiKey: vi.fn(() => "sk-test"),
  isValidApiKey: vi.fn(() => Promise.resolve({ id: "k1" })),
  isProviderAllowed: vi.fn(() => Promise.resolve(true)),
  isComboAllowed: vi.fn(() => Promise.resolve(true)),
  isKindAllowed: vi.fn(() => Promise.resolve(true)),
  isTrustedInternalRequest: vi.fn(() => false),
  getProviderCredentials: vi.fn(() => Promise.resolve({})),
  isModelAllowed: vi.fn(),
  getSettings: vi.fn(() => Promise.resolve({ requireApiKey: true })),
  getModelAliases: vi.fn(() => Promise.resolve({})),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(() => Promise.resolve(null)),
  handleChatCore: vi.fn(() => Promise.resolve({ success: true, response: new Response("ok") })),
  handleBypassRequest: vi.fn(() => null),
  cacheClaudeHeaders: vi.fn(),
  detectFormatByEndpoint: vi.fn(() => null),
  unavailableResponse: vi.fn((s, m) => new Response(m, { status: s })),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
  isProviderAllowed: mocks.isProviderAllowed,
  isComboAllowed: mocks.isComboAllowed,
  isKindAllowed: mocks.isKindAllowed,
  isTrustedInternalRequest: mocks.isTrustedInternalRequest,
  getProviderCredentials: mocks.getProviderCredentials,
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn((p, c) => Promise.resolve(c)),
  getProjectIdForConnection: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/sse/services/allowedModels.js", () => ({ isModelAllowed: mocks.isModelAllowed }));
vi.mock("@/sse/services/localDb.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("@/sse/services/bypass.js", () => ({ handleBypassRequest: mocks.handleBypassRequest }));
vi.mock("@/sse/services/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: mocks.cacheClaudeHeaders }));
vi.mock("@/sse/utils/detectFormat.js", () => ({ detectFormatByEndpoint: mocks.detectFormatByEndpoint }));
vi.mock("@/sse/utils/unavailableResponse.js", () => ({ unavailableResponse: mocks.unavailableResponse }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

// Keep every real export (getSettings, getProviderConnections, …) and override
// only the alias map — the alias lookup is the one piece under test.
vi.mock("@/lib/localDb", async (importOriginal) => ({
  ...(await importOriginal()),
  getModelAliases: mocks.getModelAliases,
  getSettings: mocks.getSettings,
}));

// What /v1/models advertises for this provider: the SHORT form only.
const ALLOWED = new Set(["za/glm-5.3-flash"]);

// getModelInfo already resolved the alias; it hands back the LONG provider id.
const modelInfo = (provider, model) => ({ provider, model, isAlias: false, providerAlias: provider });

const request = (body) =>
  new Request("http://127.0.0.1:20128/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify(body),
  });

describe("alias target is a valid allowlist candidate", () => {
  let handleChat;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.isModelAllowed.mockImplementation(async (id) => ALLOWED.has(id));
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.handleChatCore.mockImplementation(() => Promise.resolve({ success: true, response: new Response("ok") }));
    mocks.getModelAliases.mockResolvedValue({ "glm-5.3-flash": "za/glm-5.3-flash" });
    vi.resetModules();
    ({ handleChat } = await import("@/sse/handlers/chat.js"));
  });

  it("serves an aliased model whose target is listed under the short provider form", async () => {
    // client sent the alias; resolver expanded za → zai
    mocks.getModelInfo.mockReturnValue(modelInfo("zai", "glm-5.3-flash"));

    const res = await handleChat(request({ model: "glm-5.3-flash", messages: [] }));

    expect(res.status).not.toBe(404);
    expect(mocks.handleChatCore).toHaveBeenCalled();
  });

  it("probes the alias target string, not just the resolved id", async () => {
    mocks.getModelInfo.mockReturnValue(modelInfo("zai", "glm-5.3-flash"));

    await handleChat(request({ model: "glm-5.3-flash", messages: [] }));

    const probed = mocks.isModelAllowed.mock.calls.map((c) => c[0]);
    expect(probed).toContain("za/glm-5.3-flash");
  });

  it("still 404s when neither the resolved id nor the alias target is listed", async () => {
    mocks.getModelAliases.mockResolvedValue({ "glm-5.3-flash": "za/not-a-real-model" });
    mocks.getModelInfo.mockReturnValue(modelInfo("zai", "glm-5.3-flash"));

    const res = await handleChat(request({ model: "glm-5.3-flash", messages: [] }));

    expect(res.status).toBe(404);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("still serves the model when the alias store itself blows up", async () => {
    // A missing/broken alias repo must degrade to the resolved-id candidates,
    // never turn a listed model into a 404.
    mocks.getModelAliases.mockRejectedValue(new Error("alias store down"));
    mocks.getModelInfo.mockReturnValue(modelInfo("za", "glm-5.3-flash"));

    const res = await handleChat(request({ model: "za/glm-5.3-flash", messages: [] }));

    expect(res.status).not.toBe(404);
    expect(mocks.handleChatCore).toHaveBeenCalled();
  });

  it("does not consult the alias map for a model that is not an alias", async () => {
    mocks.getModelAliases.mockResolvedValue({ "glm-5.3-flash": "za/glm-5.3-flash" });
    mocks.getModelInfo.mockReturnValue(modelInfo("nvidia", "not-a-real-model"));

    const res = await handleChat(request({ model: "nvidia/not-a-real-model", messages: [] }));

    expect(res.status).toBe(404);
    expect(mocks.isModelAllowed.mock.calls.map((c) => c[0])).not.toContain("za/glm-5.3-flash");
  });
});
