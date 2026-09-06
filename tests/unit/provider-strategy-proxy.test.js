import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProviderNodeById: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

function makeConnection(providerSpecificData = {}) {
  return {
    id: "grok-connection",
    provider: "grok-cli",
    authType: "oauth",
    name: "Grok account",
    email: "grok@example.test",
    isActive: true,
    testStatus: "active",
    accessToken: "access-token-fixture",
    refreshToken: "refresh-token-fixture",
    providerSpecificData,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({
    providerStrategies: { "grok-cli": { proxyPoolId: "vercel-pool" } },
  });
  mocks.getProviderConnections.mockResolvedValue([makeConnection()]);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({
    source: "vercel",
    proxyPoolId: "vercel-pool",
    vercelRelayUrl: "https://relay.example.test",
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    strictProxy: false,
  });
});

describe("provider strategy proxy inheritance", () => {
  it("applies global static pool to an OAuth connection without assignment", async () => {
    const credentials = await getProviderCredentials("grok-cli", null, "grok-4.6");

    expect(mocks.resolveConnectionProxyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ proxyPoolId: "vercel-pool" }),
      "grok-connection",
    );
    expect(credentials.providerSpecificData).toMatchObject({
      proxyPoolId: "vercel-pool",
      vercelRelayUrl: "https://relay.example.test",
    });
  });

  it("preserves explicit account assignment over global pool", async () => {
    mocks.getProviderConnections.mockResolvedValue([makeConnection({ proxyPoolId: "account-pool" })]);

    await getProviderCredentials("grok-cli", null, "grok-4.6");

    expect(mocks.resolveConnectionProxyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ proxyPoolId: "account-pool" }),
      "grok-connection",
    );
  });

  it("inherits the global pool when legacy account metadata is empty", async () => {
    mocks.getProviderConnections.mockResolvedValue([makeConnection({ proxyPoolId: null })]);

    const credentials = await getProviderCredentials("grok-cli", null, "grok-4.6");

    expect(mocks.resolveConnectionProxyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ proxyPoolId: "vercel-pool" }),
      "grok-connection",
    );
    expect(credentials.providerSpecificData.proxyPoolId).toBe("vercel-pool");
  });
});