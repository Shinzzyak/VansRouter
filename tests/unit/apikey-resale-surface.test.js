// Guard for the resale surface: minting a fully-policed key in one call, and
// letting the key holder read its own status without the dashboard.
//
// Two defects this pins shut:
//
//  1. POST /api/keys read only `limits` and the repo hardcoded the three ACL
//     columns to NULL, so a key minted with an allow-list came back
//     unrestricted — the seller had to notice and apply a second PUT. Caught by
//     probing the live router (a key created with allowedProviders:[x] served a
//     provider outside that list).
//  2. The policy of a sold key was only readable through the admin dashboard
//     (CLI token). GET /api/v1/key is the buyer's own reader: it answers "alive?
//     expiring when? what may I reach? how much quota left?" to whoever holds
//     the key — and to nobody else.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    created: [],
    keys: [],
    valid: null,
    gate: { allowed: true },
  };
  return { state };
});

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getApiKeys: async () => h.state.keys,
  getApiKeyUsageSnapshot: () => ({ rpm: { limit: 10, used: 1 } }),
  createApiKey: async (name, machineId, limits) => {
    h.state.created.push({ name, machineId, limits });
    return {
      id: "key-new",
      key: "vr-live-NEWKEY-0123456789",
      keyDisplay: "vr-l…6789",
      name,
      machineId,
      allowedProviders: limits.allowedProviders ?? null,
      allowedCombos: limits.allowedCombos ?? null,
      allowedKinds: limits.allowedKinds ?? null,
      allowedModels: limits.allowedModels ?? [],
      personaInject: limits.personaInject === false ? false : true,
      expiresAt: limits.expiresAt ?? null,
      maxTokens: limits.maxTokens ?? null,
      maxTokensDaily: limits.maxTokensDaily ?? null,
      rpm: limits.rpm ?? null,
      rph: limits.rph ?? null,
      rpd: limits.rpd ?? null,
      tokens5h: limits.tokens5h ?? null,
      tokensWeekly: limits.tokensWeekly ?? null,
      tokensMonthly: limits.tokensMonthly ?? null,
      rateLimitTpm: limits.rateLimitTpm ?? null,
      rateLimitConcurrency: limits.rateLimitConcurrency ?? null,
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
  isValidApiKey: async (token) => (token === "k-live" ? h.state.valid : null),
  isProviderAllowed: async () => true,
  isComboAllowed: () => true,
  isKindAllowed: () => true,
  clientIp: () => "203.0.113.7",
}));

vi.mock("@/lib/db/repos/apiKeyUsageRepo.js", () => ({
  checkApiKeyLimits: () => h.state.gate,
}));

const keysRoute = await import("@/app/api/keys/route.js");
const keyStatusRoute = await import("@/app/api/v1/key/route.js");

const post = (body) =>
  new Request("http://local/api/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const keyed = (token) =>
  new Request("http://local/api/v1/key", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeEach(() => {
  h.state.created = [];
  h.state.keys = [];
  h.state.gate = { allowed: true };
  h.state.valid = {
    id: "key-live",
    key: "vr-live-SECRET-do-not-echo",
    name: "buyer-a",
    keyDisplay: "vr-l…6789",
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    lastUsedAt: "2026-10-12T08:00:00.000Z",
    usedCount: 42,
    personaInject: true,
    rpm: 60,
    rph: null,
    rpd: 1000,
    maxTokens: null,
    maxTokensDaily: null,
    tokens5h: null,
    tokensWeekly: null,
    tokensMonthly: null,
    rateLimitTpm: null,
    rateLimitConcurrency: 4,
    allowedProviders: ["cbai"],
    allowedCombos: ["smart-fallback"],
    allowedKinds: ["llm"],
    allowedModels: ["za/glm-5.3-flash"],
    allowedIps: null,
  };
});

describe("POST /api/keys mints a fully-policed key in one call", () => {
  it("forwards the three ACL lists and the model allowlist to the repo", async () => {
    const res = await keysRoute.POST(post({
      name: "buyer-a",
      limits: { rpm: 60, expiresAt: "2026-11-01T00:00:00.000Z" },
      allowedProviders: ["cbai"],
      allowedCombos: ["smart-fallback"],
      allowedKinds: ["llm"],
      allowedModels: ["za/glm-5.3-flash"],
    }));

    expect(res.status).toBe(201);
    const sent = h.state.created[0].limits;
    expect(sent.allowedProviders).toEqual(["cbai"]);
    expect(sent.allowedCombos).toEqual(["smart-fallback"]);
    expect(sent.allowedKinds).toEqual(["llm"]);
    expect(sent.allowedModels).toEqual(["za/glm-5.3-flash"]);
    // limits still ride along untouched
    expect(sent.rpm).toBe(60);
    expect(sent.expiresAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("accepts the policy nested under `limits` too", async () => {
    const res = await keysRoute.POST(post({
      name: "buyer-b",
      limits: { allowedProviders: ["zai"], rpm: 5 },
    }));

    expect(res.status).toBe(201);
    const sent = h.state.created[0].limits;
    expect(sent.allowedProviders).toEqual(["zai"]);
    expect(sent.rpm).toBe(5);
  });

  it("echoes the policy back so the seller can confirm what landed", async () => {
    const res = await keysRoute.POST(post({
      name: "buyer-c",
      allowedProviders: ["cbai"],
      allowedModels: ["za/*"],
      personaInject: false,
    }));
    const body = await res.json();

    expect(body.allowedProviders).toEqual(["cbai"]);
    expect(body.allowedModels).toEqual(["za/*"]);
    expect(body.personaInject).toBe(false);
    expect(body.key).toBe("vr-live-NEWKEY-0123456789");
  });

  it("still refuses a nameless key", async () => {
    const res = await keysRoute.POST(post({ allowedProviders: ["cbai"] }));
    expect(res.status).toBe(400);
    expect(h.state.created).toHaveLength(0);
  });

  it("rejects a malformed model allowlist instead of half-minting", async () => {
    const res = await keysRoute.POST(post({ name: "buyer-d", allowedModels: "za/*" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/string array/);
    expect(h.state.created).toHaveLength(0);
  });
});

describe("GET /api/v1/key is the buyer's own status reader", () => {
  it("refuses without a key", async () => {
    const res = await keyStatusRoute.GET(keyed(null));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Missing API key/);
  });

  it("refuses an unresolvable key even in local mode (requireApiKey=false)", async () => {
    // The endpoint hands out expiry, quota and access policy. A supplied-but-
    // dead secret must not be able to read that policy.
    const res = await keyStatusRoute.GET(keyed("k-dead"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Invalid, expired or disabled/);
  });

  it("answers the holder with policy, usage and the live gate", async () => {
    const res = await keyStatusRoute.GET(keyed("k-live"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.object).toBe("key");
    expect(body.name).toBe("buyer-a");
    expect(body.expiresAt).toBe("2026-11-01T00:00:00.000Z");
    expect(body.usedCount).toBe(42);
    expect(body.limits.rpm).toBe(60);
    expect(body.limits.rateLimitConcurrency).toBe(4);
    expect(body.usage).toEqual({ rpm: { limit: 10, used: 1 } });
    expect(body.gate).toEqual({ allowed: true, reason: null, retryAfterMs: null });
    expect(body.access).toEqual({
      providers: ["cbai"],
      combos: ["smart-fallback"],
      kinds: ["llm"],
      models: ["za/glm-5.3-flash"],
      ips: null,
    });
  });

  it("surfaces a blocked gate so a buyer can tell 429 from out-of-quota", async () => {
    h.state.gate = { allowed: false, reason: "rpm limit exceeded", retryAfterMs: 1200 };
    const res = await keyStatusRoute.GET(keyed("k-live"));
    const body = await res.json();

    expect(res.status).toBe(200); // reading your own status is never rate-limited
    expect(body.gate.allowed).toBe(false);
    expect(body.gate.reason).toBe("rpm limit exceeded");
    expect(body.gate.retryAfterMs).toBe(1200);
  });

  it("never echoes the secret itself", async () => {
    const res = await keyStatusRoute.GET(keyed("k-live"));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("SECRET-do-not-echo");
    expect(text).toContain("vr-l…6789"); // masked display form only
  });

  it("is a public-prefix route, so the guard makes a remote caller authenticate", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/dashboardGuard.js"), "utf8");
    const block = src.slice(src.indexOf("PUBLIC_PREFIXES"));
    expect(block.slice(0, block.indexOf("]"))).toContain('"/api/v1"');
  });
});
