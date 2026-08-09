import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: resolveConnectionProxyConfig with proxyPoolIds (ConnectionRow
// multi-pool format) must resolve a pool even when excludePoolIds is omitted
// (all callers except chat.js pool-fallback pass 0-2 args). Previously the
// null excludePoolIds flowed into pickProxyPoolId → excludeIds.includes()
// threw → catch swallowed it → source:"error" → pool proxy never applied
// (visible on freebuff connections, but provider-agnostic).

const poolRows = new Map([
  ["pool-1", { id: "pool-1", name: "P1", proxyUrl: "http://proxy1:8080", isActive: true, type: "http", noProxy: "", strictProxy: false }],
  ["pool-2", { id: "pool-2", name: "P2", proxyUrl: "http://proxy2:8080", isActive: true, type: "http", noProxy: "", strictProxy: false }],
]);

vi.mock("@/models/index.js", () => ({
  getProxyPoolById: vi.fn(async (id) => poolRows.get(id) || null),
}));

vi.mock("open-sse/services/proxyPoolFitness.js", () => ({
  fitPoolIds: (ids) => ids,
  loadPoolFitness: vi.fn(async () => {}),
}));

import { resolveConnectionProxyConfig } from "../../src/lib/network/connectionProxy.js";

describe("resolveConnectionProxyConfig multi-pool (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves proxyPoolIds to a pool URL when excludePoolIds is omitted", async () => {
    const resolved = await resolveConnectionProxyConfig(
      { proxyPoolIds: ["pool-1", "pool-2"], proxyRotationStrategy: "round-robin" },
      "conn-1",
    );
    expect(resolved.source).toBe("pool");
    expect(resolved.connectionProxyEnabled).toBe(true);
    expect(resolved.connectionProxyUrl).toMatch(/^http:\/\/proxy[12]:8080$/);
    expect(resolved.proxyPoolId).toMatch(/^pool-[12]$/);
  });

  it("resolves proxyPoolIds when excludePoolIds is null (getProviderCredentials shape)", async () => {
    const resolved = await resolveConnectionProxyConfig(
      { proxyPoolIds: ["pool-1"], proxyRotationStrategy: "none" },
      "conn-2",
      null,
    );
    expect(resolved.source).toBe("pool");
    expect(resolved.connectionProxyUrl).toBe("http://proxy1:8080");
  });

  it("still honors a real excludePoolIds array (pool-fallback retry)", async () => {
    const resolved = await resolveConnectionProxyConfig(
      { proxyPoolIds: ["pool-1", "pool-2"], proxyRotationStrategy: "fill-first" },
      "conn-3",
      ["pool-1"],
    );
    expect(resolved.proxyPoolId).toBe("pool-2");
    expect(resolved.connectionProxyUrl).toBe("http://proxy2:8080");
  });

  it("falls back cleanly when the pool is missing", async () => {
    const resolved = await resolveConnectionProxyConfig(
      { proxyPoolIds: ["pool-missing"], proxyRotationStrategy: "none" },
      "conn-4",
    );
    expect(resolved.source).not.toBe("error");
    expect(resolved.connectionProxyEnabled).toBe(false);
  });
});
