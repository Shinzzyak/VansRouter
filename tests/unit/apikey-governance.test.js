// Guard for the 9router-go resale-governance parity work on apiKeys:
// masked display, TPM limit, concurrency limit, rotate/toggle surfaces.
// Pure-module tests — no DB needed, so they stay fast and deterministic.
import { describe, it, expect, beforeEach } from "vitest";
import { maskApiKey, MASKED_UNKNOWN } from "@/lib/db/helpers/apiKeyMask.js";
import {
  checkApiKeyLimits,
  recordApiKeyUsage,
  acquireApiKeyLease,
  releaseApiKeyLease,
  getApiKeyUsageSnapshot,
} from "@/lib/db/repos/apiKeyUsageRepo.js";
import { TABLES, SCHEMA_VERSION } from "@/lib/db/schema.js";

// The module binds `counters` to the global object at import time, so resetting
// the maps in place is the only way to get a clean slate between tests.
function freshCounters() {
  const c = global._apiKeyCounters;
  if (!c) return;
  for (const map of Object.values(c)) map.clear();
}

describe("apiKeyMask parity with keikey.Mask", () => {
  it("masks long keys as prefix…suffix", () => {
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("sk-a…mnop");
  });

  it("collapses short keys to *** so no entropy leaks", () => {
    expect(maskApiKey("short")).toBe(MASKED_UNKNOWN);
    expect(maskApiKey("123456789012")).toBe(MASKED_UNKNOWN); // exactly the threshold
    expect(maskApiKey("")).toBe(MASKED_UNKNOWN);
    expect(maskApiKey(null)).toBe(MASKED_UNKNOWN);
  });
});

describe("apiKeys schema carries the governance columns", () => {
  it("declares every resale column", () => {
    const cols = Object.keys(TABLES.apiKeys.columns);
    for (const c of [
      "rateLimitTpm",
      "rateLimitConcurrency",
      "keyDisplay",
      "lastUsedAt",
      "usedCount",
      "metadata",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("bumped SCHEMA_VERSION so a pre-change backup is taken", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
  });
});

describe("per-key TPM limit", () => {
  beforeEach(freshCounters);

  it("allows traffic under the limit and rejects past it", () => {
    const key = { id: "k-tpm", rateLimitTpm: 1000 };
    expect(checkApiKeyLimits(key, 600).allowed).toBe(true);
    recordApiKeyUsage(key, 600);
    expect(checkApiKeyLimits(key, 400).allowed).toBe(true);
    const blocked = checkApiKeyLimits(key, 401);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/tokens per minute/i);
  });

  it("stays out of the way when the key sets no TPM limit", () => {
    const key = { id: "k-tpm-none" };
    expect(checkApiKeyLimits(key, 10_000_000).allowed).toBe(true);
  });
});

describe("per-key concurrency limit", () => {
  beforeEach(freshCounters);

  it("rejects the request that would exceed the slot count", () => {
    const key = { id: "k-conc", rateLimitConcurrency: 2 };
    expect(checkApiKeyLimits(key).allowed).toBe(true);
    acquireApiKeyLease(key);
    expect(checkApiKeyLimits(key).allowed).toBe(true);
    acquireApiKeyLease(key);
    const blocked = checkApiKeyLimits(key);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/concurrency/i);
  });

  it("frees the slot when usage is recorded", () => {
    const key = { id: "k-conc2", rateLimitConcurrency: 1 };
    acquireApiKeyLease(key);
    expect(checkApiKeyLimits(key).allowed).toBe(false);
    recordApiKeyUsage(key, 5); // the in-flight request reported in
    expect(checkApiKeyLimits(key).allowed).toBe(true);
  });

  it("releaseApiKeyLease is safe when nothing is held", () => {
    const key = { id: "k-conc3", rateLimitConcurrency: 1 };
    expect(() => releaseApiKeyLease(key)).not.toThrow();
    expect(checkApiKeyLimits(key).allowed).toBe(true);
  });

  it("snapshot reports the live slot count", () => {
    const key = { id: "k-conc4", rateLimitConcurrency: 4 };
    acquireApiKeyLease(key);
    acquireApiKeyLease(key);
    expect(getApiKeyUsageSnapshot(key).rateLimitConcurrency).toEqual({ limit: 4, used: 2 });
  });
});

describe("rotate and toggle surfaces exist", () => {
  it("exposes POST /api/keys/[id]/rotate", async () => {
    const mod = await import("@/app/api/keys/[id]/rotate/route.js");
    expect(typeof mod.POST).toBe("function");
  });

  it("exposes PUT /api/keys/[id]/toggle", async () => {
    const mod = await import("@/app/api/keys/[id]/toggle/route.js");
    expect(typeof mod.PUT).toBe("function");
  });
});
