// K273 — balanced account selection, small-fleet rescue, honest unavailable label.
//
// Ported from 9Router Pro because fill-first has one failure mode that hurts a
// small fleet: the first seat eats every request until it errors, so one dead
// key reads as a dead provider and the healthy seats behind it never carry load.
// These tests pin the three behaviours that fix it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const updateProviderConnection = vi.fn();
const getProviderConnections = vi.fn();
const getSettings = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections,
  updateProviderConnection,
  getSettings,
  validateApiKey: vi.fn(),
  getProviderNodeById: vi.fn(),
  getApiKeyByValueAny: vi.fn(),
  getProxyPools: vi.fn().mockResolvedValue([]),
}));

const {
  getProviderCredentials,
  flushLastUsed,
} = await import("../../src/sse/services/auth.js");
const {
  pickWindowedLru,
  connectionHealthTier,
  shouldStampUnavailable,
  lastUsedOverlay,
  SUSPECT_PROBATION_MS,
} = await import("../../open-sse/services/accountFallback.js");

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

describe("pickWindowedLru", () => {
  it("returns null for an empty fleet", () => {
    expect(pickWindowedLru([], 32)).toBeNull();
    expect(pickWindowedLru(null, 32)).toBeNull();
  });

  it("prefers never-used seats, ordered by priority", () => {
    const picked = pickWindowedLru(
      [
        { id: "used", lastUsedAt: iso(-60_000), priority: 1 },
        { id: "fresh-high", priority: 9 },
        { id: "fresh-low", priority: 2 },
      ],
      1,
      () => 0,
    );
    expect(picked.id).toBe("fresh-low");
  });

  it("spreads picks over the window instead of always taking one seat", () => {
    const fleet = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      lastUsedAt: iso(-100_000 + i * 1000),
    }));
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(pickWindowedLru(fleet, 4).id);
    // Window of 4 over 10 seats: several distinct seats must appear.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("lets the overlay override a stale stored timestamp", () => {
    const fleet = [
      { id: "a", lastUsedAt: iso(-500_000) },
      { id: "b", lastUsedAt: iso(-400_000) },
    ];
    const overlay = new Map([["a", Date.now()]]);
    const picked = pickWindowedLru(fleet, 1, () => 0, overlay);
    expect(picked.id).toBe("b");
  });
});

describe("connectionHealthTier", () => {
  it("treats a clean account as tier 0", () => {
    expect(connectionHealthTier({ id: "a" })).toBe(0);
  });

  it("treats a recently failed account as tier 1 (suspect)", () => {
    expect(connectionHealthTier({ id: "a", backoffLevel: 2, lastErrorAt: iso(-1000) })).toBe(1);
    expect(connectionHealthTier({ id: "a", lastError: "429 quota" })).toBe(1);
  });

  it("heals a suspect account once the probation window has passed", () => {
    const conn = { id: "a", lastError: "429", lastErrorAt: iso(-SUSPECT_PROBATION_MS - 1000) };
    expect(connectionHealthTier(conn, Date.now(), SUSPECT_PROBATION_MS)).toBe(0);
  });
});

describe("shouldStampUnavailable", () => {
  it("does not brand a short transient lock as dead", () => {
    expect(shouldStampUnavailable(3_000)).toBe(false);
    expect(shouldStampUnavailable(30_000)).toBe(false);
  });

  it("brands a substantial cooldown", () => {
    expect(shouldStampUnavailable(60_000)).toBe(true);
    expect(shouldStampUnavailable(3_600_000)).toBe(true);
  });
});

describe("getProviderCredentials — balanced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastUsedOverlay.clear();
    getSettings.mockResolvedValue({ fallbackStrategy: "balanced" });
    updateProviderConnection.mockResolvedValue({});
  });

  it("serves a clean seat while a suspect seat exists", async () => {
    getProviderConnections.mockResolvedValue([
      { id: "dead", priority: 1, backoffLevel: 3, lastError: "402 credits", lastErrorAt: iso(-1000) },
      { id: "alive", priority: 9 },
    ]);
    const creds = await getProviderCredentials("openai", null, "gpt-4o");
    expect(creds.connectionId).toBe("alive");
  });

  it("stamps the in-memory overlay synchronously and defers the DB write", async () => {
    getProviderConnections.mockResolvedValue([{ id: "solo", priority: 1 }]);
    const creds = await getProviderCredentials("openai", null, "gpt-4o");
    expect(creds.connectionId).toBe("solo");
    // Overlay updated immediately — this is what keeps concurrent picks apart.
    expect(lastUsedOverlay.has("solo")).toBe(true);
    // The write is coalesced, not awaited by the request path.
    expect(updateProviderConnection).not.toHaveBeenCalled();
    await flushLastUsed();
    expect(updateProviderConnection).toHaveBeenCalledWith("solo", expect.objectContaining({ consecutiveUseCount: 1 }));
  });

  it("falls back to suspect seats when every seat is suspect", async () => {
    getProviderConnections.mockResolvedValue([
      { id: "s1", backoffLevel: 1, lastError: "429", lastErrorAt: iso(-1000) },
      { id: "s2", backoffLevel: 1, lastError: "429", lastErrorAt: iso(-1000) },
    ]);
    const creds = await getProviderCredentials("openai", null, "gpt-4o");
    expect(["s1", "s2"]).toContain(creds.connectionId);
  });
});

describe("getProviderCredentials — small-fleet rescue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastUsedOverlay.clear();
    getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    updateProviderConnection.mockResolvedValue({});
  });

  it("waits out a short lock on a one-seat fleet instead of failing", async () => {
    getProviderConnections.mockResolvedValue([
      { id: "only", priority: 1, "modelLock_gpt-4o": iso(250) },
    ]);
    const started = Date.now();
    const creds = await getProviderCredentials("openai", null, "gpt-4o");
    expect(creds.connectionId).toBe("only");
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it("does not stall when the lock is longer than the rescue budget", async () => {
    getProviderConnections.mockResolvedValue([
      { id: "only", priority: 1, "modelLock_gpt-4o": iso(10 * 60 * 1000) },
    ]);
    const started = Date.now();
    const res = await getProviderCredentials("openai", null, "gpt-4o");
    expect(res.allRateLimited).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("never rescues a fleet bigger than the rescue limit", async () => {
    const fleet = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      "modelLock_gpt-4o": iso(250),
    }));
    getProviderConnections.mockResolvedValue(fleet);
    const started = Date.now();
    const res = await getProviderCredentials("openai", null, "gpt-4o");
    expect(res.allRateLimited).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
