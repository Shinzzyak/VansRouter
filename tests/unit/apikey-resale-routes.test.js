// Route-level guard for the wave-2 resale surface: batch minting, the IP
// allow-list and the per-key traffic log. Semantics live in apikey-resale-hardening.test.js; this
// file is about what each HTTP surface accepts, refuses and returns.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    created: [],
    key: null,
    stats: { requests: 0, errors: 0, firstAt: null, lastAt: null },
    details: { pagination: { page: 1, pageSize: 50, total: 0 }, details: [] },
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getApiKeys: async () => [],
  getApiKeyUsageSnapshot: () => ({}),
  getApiKeyById: async (id) => (h.state.key && h.state.key.id === id ? h.state.key : null),
  createApiKey: async (name, machineId, limits) => {
    h.state.created.push({ name, machineId, limits });
    return {
      id: `key-${h.state.created.length}`,
      key: `vr-live-${h.state.created.length}`,
      keyDisplay: `vr-l…${h.state.created.length}`,
      name,
      machineId,
      isActive: true,
      allowedProviders: limits.allowedProviders ?? null,
      allowedCombos: limits.allowedCombos ?? null,
      allowedKinds: limits.allowedKinds ?? null,
      allowedModels: limits.allowedModels ?? [],
      allowedIps: limits.allowedIps ?? null,
      tokenBalance: limits.tokenBalance ?? null,
      personaInject: limits.personaInject ?? true,
      metadata: limits.metadata ?? null,
    };
  },
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: async () => "machine-1",
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => {
    const raw = request?.headers?.get("authorization") || "";
    return raw.startsWith("Bearer ") ? raw.slice(7) : null;
  },
  isValidApiKey: async (token) => (token === "k-live" ? { id: "key-live", name: "buyer-a", keyDisplay: "vr-l…6789" } : null),
}));

vi.mock("@/lib/db/repos/requestDetailsRepo.js", () => ({
  getRequestDetails: async () => h.state.details,
  getRequestStatsForApiKey: async () => h.state.stats,
}));

const keysRoute = await import("@/app/api/keys/route.js");
const logsRoute = await import("@/app/api/keys/[id]/logs/route.js");

const post = (url, body, headers = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.state.created = [];
  h.state.key = { id: "key-live", name: "buyer-a", keyDisplay: "vr-l…6789", tokenBalance: 600, tokensSpent: 100, expiresAt: "2026-12-01T00:00:00.000Z", isActive: true };
  h.state.stats = { requests: 0, errors: 0, firstAt: null, lastAt: null };
  h.state.details = { pagination: { page: 1, pageSize: 50, total: 0 }, details: [] };
});

describe("POST /api/keys — batch mint and IP binding", () => {
  it("mints a batch of N keys with tellable names", async () => {
    const res = await keysRoute.POST(post("http://local/api/keys", { name: "order-77", quantity: 3, tokenBalance: 1000 }));
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.count).toBe(3);
    expect(body.keys).toHaveLength(3);
    expect(body.keys.map((k) => k.name)).toEqual(["order-77 #1", "order-77 #2", "order-77 #3"]);
    expect(h.state.created.every((c) => c.limits.tokenBalance === 1000)).toBe(true);
  });

  it("keeps the single-key response shape for quantity=1", async () => {
    const res = await keysRoute.POST(post("http://local/api/keys", { name: "solo", allowedIps: ["203.0.113.7"] }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.key).toBe("vr-live-1");
    expect(body.count).toBeUndefined();
    expect(body.allowedIps).toEqual(["203.0.113.7"]);
  });

  it("clamps an absurd quantity instead of minting unbounded rows", async () => {
    const res = await keysRoute.POST(post("http://local/api/keys", { name: "flood", quantity: 5000 }));
    expect((await res.json()).count).toBe(100);
    expect(h.state.created).toHaveLength(100);
  });

  it("refuses a malformed IP allow-list rather than silently opening the key", async () => {
    const res = await keysRoute.POST(post("http://local/api/keys", { name: "bad-ip", allowedIps: "203.0.113.7" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/allowedIps/);
    expect(h.state.created).toHaveLength(0);
  });
});

describe("GET /api/keys/[id]/logs — per-key traffic", () => {
  it("404s for an unknown key", async () => {
    const res = await logsRoute.GET(new Request("http://local/api/keys/nope/logs"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("returns the rollup and the page of details for a real key", async () => {
    h.state.stats = { requests: 12, errors: 2, firstAt: "2026-10-12T00:00:00.000Z", lastAt: "2026-10-12T09:00:00.000Z" };
    const res = await logsRoute.GET(new Request("http://local/api/keys/key-live/logs?pageSize=5"), {
      params: Promise.resolve({ id: "key-live" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.keyId).toBe("key-live");
    expect(body.stats.requests).toBe(12);
    expect(body.stats.errors).toBe(2);
    expect(body.pagination.pageSize).toBe(50);
  });
});

