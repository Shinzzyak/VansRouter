// Route-level guard for the wave-2 resale surface: batch minting, the IP
// allow-list, the admin redeem-code endpoints, the buyer redeem endpoint and the
// per-key traffic log. Semantics live in apikey-resale-hardening.test.js; this
// file is about what each HTTP surface accepts, refuses and returns.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    created: [],
    key: null,
    codes: [],
    redeemed: null,
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

vi.mock("@/lib/db/repos/redeemCodesRepo.js", () => ({
  createRedeemCodes: async (opts) => {
    h.state.codes = Array.from({ length: opts.quantity ?? 1 }, (_, i) => ({
      id: `rc-${i}`,
      code: `AAAA-BBBB-CCC${i}`,
      tokenValue: opts.tokenValue ?? null,
      extendsDays: opts.extendsDays ?? null,
      maxUses: opts.maxUses ?? 1,
      usedCount: 0,
      isActive: true,
      batchName: opts.batchName ?? null,
      limits: opts.limits ?? null,
    }));
    return h.state.codes;
  },
  getRedeemCodes: async () => h.state.codes,
  getRedeemCodeById: async (id) => h.state.codes.find((c) => c.id === id) || null,
  revokeRedeemCode: async (id) => {
    const found = h.state.codes.find((c) => c.id === id);
    return found ? { ...found, isActive: false } : null;
  },
  deleteRedeemCode: async (id) => h.state.codes.some((c) => c.id === id),
  redeemCode: async (code) => {
    if (h.state.redeemed === null) return { ok: false, error: `Unknown redeem code` };
    return h.state.redeemed;
  },
}));

vi.mock("@/lib/db/repos/requestDetailsRepo.js", () => ({
  getRequestDetails: async () => h.state.details,
  getRequestStatsForApiKey: async () => h.state.stats,
}));

const keysRoute = await import("@/app/api/keys/route.js");
const logsRoute = await import("@/app/api/keys/[id]/logs/route.js");
const redeemCodesRoute = await import("@/app/api/redeem-codes/route.js");
const redeemCodeRoute = await import("@/app/api/redeem-codes/[id]/route.js");
const buyerRedeemRoute = await import("@/app/api/v1/redeem/route.js");

const post = (url, body, headers = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.state.created = [];
  h.state.codes = [];
  h.state.redeemed = null;
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

describe("admin redeem-code endpoints", () => {
  it("refuses a code that carries nothing", async () => {
    const res = await redeemCodesRoute.POST(post("http://local/api/redeem-codes", { quantity: 2 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tokenValue, extendsDays or limits/);
  });

  it("refuses a negative token value", async () => {
    const res = await redeemCodesRoute.POST(post("http://local/api/redeem-codes", { tokenValue: -5 }));
    expect(res.status).toBe(400);
  });

  it("mints a batch and reports a summary", async () => {
    const minted = await redeemCodesRoute.POST(post("http://local/api/redeem-codes", { quantity: 3, batchName: "b1", tokenValue: 500 }));
    expect(minted.status).toBe(201);
    expect((await minted.json()).count).toBe(3);

    const listed = await redeemCodesRoute.GET(new Request("http://local/api/redeem-codes"));
    const body = await listed.json();
    expect(body.count).toBe(3);
    expect(body.summary.unused).toBe(3);
  });

  it("carries the whole quota surface, not just the token total", async () => {
    const res = await redeemCodesRoute.POST(
      post("http://local/api/redeem-codes", {
        quantity: 2,
        tokenValue: 2_000_000,
        extendsDays: 30,
        limits: { rpm: 60, rateLimitTpm: 20_000, rateLimitConcurrency: 3, maxTokensDaily: 500_000 },
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.codes[0].limits).toMatchObject({
      rpm: 60,
      rateLimitTpm: 20_000,
      rateLimitConcurrency: 3,
      maxTokensDaily: 500_000,
    });
  });

  it("accepts a code that carries limits only — the axis set is the product", async () => {
    const res = await redeemCodesRoute.POST(
      post("http://local/api/redeem-codes", { quantity: 1, limits: { rpm: 60 } })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).codes[0].limits.rpm).toBe(60);
  });

  it("refuses limits that are not an object", async () => {
    const res = await redeemCodesRoute.POST(
      post("http://local/api/redeem-codes", { tokenValue: 100, limits: ["rpm"] })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/limits must be an object/);
  });

  it("refuses a malformed IP list inside limits rather than opening the key", async () => {
    const res = await redeemCodesRoute.POST(
      post("http://local/api/redeem-codes", { tokenValue: 100, limits: { allowedIps: "203.0.113.7" } })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/allowedIps/);
  });

  it("drops unknown axes instead of storing junk", async () => {
    const res = await redeemCodesRoute.POST(
      post("http://local/api/redeem-codes", { quantity: 1, tokenValue: 100, limits: { rpm: 10, nonsense: 5 } })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).codes[0].limits).not.toHaveProperty("nonsense");
  });

  it("revokes by default and purges only on request", async () => {
    await redeemCodesRoute.POST(post("http://local/api/redeem-codes", { quantity: 1, tokenValue: 10 }));

    const revoked = await redeemCodeRoute.DELETE(new Request("http://local/api/redeem-codes/rc-0", { method: "DELETE" }), {
      params: Promise.resolve({ id: "rc-0" }),
    });
    const revokedBody = await revoked.json();
    expect(revokedBody.revoked).toBe(true);
    expect(revokedBody.code.isActive).toBe(false);

    const purged = await redeemCodeRoute.DELETE(new Request("http://local/api/redeem-codes/rc-0?purge=1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "rc-0" }),
    });
    expect((await purged.json()).deleted).toBe(true);

    const missing = await redeemCodeRoute.DELETE(new Request("http://local/api/redeem-codes/nope", { method: "DELETE" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/v1/redeem — the buyer's front door", () => {
  const issuedKey = {
    id: "key-1",
    name: "buyer",
    key: "sk-aaaa-bbbb-cccc",
    keyDisplay: "sk-a…cccc",
    tokenBalance: 5_000_000,
    expiresAt: "2026-12-01T00:00:00.000Z",
  };

  it("needs no API key: the code is the credential, and the response carries the address", async () => {
    h.state.redeemed = {
      ok: true,
      code: "AAAA-BBBB-CCCC",
      tokens: 5_000_000,
      days: 30,
      expiresAt: "2026-12-01T00:00:00.000Z",
      usesRemaining: 0,
      limits: { tokenBalance: 5_000_000, rpm: 60, rateLimitTpm: 20_000 },
      key: issuedKey,
    };

    // No Authorization header at all — a buyer redeeming has no key yet.
    const res = await buyerRedeemRoute.POST(
      post("http://local/api/v1/redeem", { code: "aaaa-bbbb-cccc" }, { host: "router.example.com" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.object).toBe("redeem");
    expect(body.redeemed).toBe(true);
    expect(body.code).toBe("AAAA-BBBB-CCCC");
    expect(body.api_key).toBe("sk-aaaa-bbbb-cccc");
    expect(body.key_display).toBe("sk-a…cccc");
    // With no pinned domain, the host the buyer reached is what they get back.
    expect(body.base_url).toBe("https://router.example.com/v1");
    expect(body.tokens).toBe(5_000_000);
    expect(body.days).toBe(30);
    expect(body.expires_at).toBe("2026-12-01T00:00:00.000Z");
    // A buyer who bought rate limits sees them, as data and as one readable line.
    expect(body.limits).toMatchObject({ tokenBalance: 5_000_000, rpm: 60, rateLimitTpm: 20_000 });
    expect(body.quota).toBe("5jt token · 20k TPM · 60/menit");
    // The page shows the token total itself, so the rate line drops it rather
    // than printing the balance twice.
    expect(body.usage_limits).toBe("20k TPM · 60/menit");
  });

  it("refuses a body with no code", async () => {
    const res = await buyerRedeemRoute.POST(post("http://local/api/v1/redeem", {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Missing redeem code/);
  });

  it("answers 400 (not 500) for an unknown, spent, revoked or expired code", async () => {
    h.state.redeemed = { ok: false, error: "Redeem code has already been used" };
    const res = await buyerRedeemRoute.POST(post("http://local/api/v1/redeem", { code: "nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/already been used/);
  });

  it("is a public-prefix route so a remote buyer can reach it", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/dashboardGuard.js"), "utf8");
    const block = src.slice(src.indexOf("PUBLIC_PREFIXES"));
    expect(block.slice(0, block.indexOf("]"))).toContain('"/api/v1"');
  });
});
