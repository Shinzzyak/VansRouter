// Layer-2 verdict regression guard (incident 2026-09-11).
//
// A single garbled/doubled upstream body produced `502 Invalid JSON response`,
// which matched NO rule in ERROR_RULES and therefore inherited
// TRANSIENT_COOLDOWN_MS (30s): one bad byte turned a 1s upstream blip into a
// 30s model-wide lock plus a 30s client wait on the retry ("waited 29998ms").
//
// Known upstream-transient 5xx now carry their own short verdict. Unknown
// statuses still fall through to the cautious 30s default — that behavior is
// asserted here too so a future edit cannot silently loosen it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

const SHORT_MS = 5_000;
const LONG_MS = 2 * 60 * 1000;

const updateProviderConnection = vi.fn();
const getProviderConnections = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections,
  updateProviderConnection,
  validateApiKey: vi.fn(),
  getSettings: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProxyPools: vi.fn(),
}));

// Import after mock
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

describe("checkFallbackError — upstream-transient 5xx verdict", () => {
  // Status di luar kelas 4xx: sejak K249 setiap 4xx non-kredensial dijawab
  // requestScoped (request ditolak, kredensial sehat), jadi kasus "status tak
  // dikenal" harus diuji dengan status non-4xx — 599 tetap jatuh ke default.
  it("keeps the 30s default for genuinely unknown statuses", () => {
    const result = checkFallbackError(599, "teapot", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
    expect(TRANSIENT_COOLDOWN_MS).toBe(30_000);
  });

  it.each([500, 502, 503, 504])("verdicts %i as a short lock, not 30s", (status) => {
    const result = checkFallbackError(status, "Invalid JSON response from provider", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(SHORT_MS);
    expect(result.cooldownMs).toBeLessThan(TRANSIENT_COOLDOWN_MS);
    // 5xx must not push the account up the exponential backoff ladder
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("verdicts a garbled-body 502 by status, not by error text", () => {
    // The exact message the router emits when a custom gateway sends
    // concatenated JSON — no rule text matches it, so the status rule decides.
    const result = checkFallbackError(
      502,
      "Invalid JSON response from openai-compatible-chat-f3f5daa2",
      0,
    );
    expect(result.cooldownMs).toBe(SHORT_MS);
  });

  it("still lets text rules win (429-style wording beats the status rule)", () => {
    const result = checkFallbackError(502, "rate limit exceeded", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBe(1);
  });

  it("keeps auth/quota/not-found verdicts at the long cooldown", () => {
    for (const status of [401, 402, 403, 404]) {
      expect(checkFallbackError(status, "nope", 0).cooldownMs).toBe(LONG_MS);
    }
  });

  it("keeps content-blocked non-fallback, and flags it as a policy verdict", () => {
    // K253: the verdict now carries isContentFilter + requestScoped, which is what
    // lets callers skip the breaker and hand the refusal to the escalation ladder.
    expect(checkFallbackError(400, "content-blocked", 0)).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
      isContentFilter: true,
      requestScoped: true,
    });
  });
});

describe("markAccountUnavailable — 502 lock duration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnections.mockResolvedValue([
      { id: "conn-1", displayName: "Custom Node", backoffLevel: 0 },
    ]);
    updateProviderConnection.mockResolvedValue({});
  });

  it("writes a ~5s model lock for an upstream 502, not 30s", async () => {
    const result = await markAccountUnavailable(
      "conn-1",
      502,
      "Invalid JSON response from provider",
      "openai-compatible-chat-x",
      "deepseek-v4.1-flash",
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(SHORT_MS);

    const update = updateProviderConnection.mock.calls[0][1];
    // K273: a 5s lock is a blip, not a dead seat. The lock still applies in
    // full — but the sticky "unavailable" label outlives the lock, and stamping
    // it here is what made a healthy pool read as an empty one.
    expect(update.testStatus).toBeUndefined();
    expect(update.errorCode).toBe(502);
    expect(update["modelLock_deepseek-v4.1-flash"]).toBeDefined();

    const lockMs = new Date(update["modelLock_deepseek-v4.1-flash"]).getTime() - Date.now();
    expect(lockMs).toBeGreaterThanOrEqual(SHORT_MS - 1_000);
    expect(lockMs).toBeLessThanOrEqual(SHORT_MS + 1_000);
    expect(lockMs).toBeLessThan(TRANSIENT_COOLDOWN_MS);
  });

  it("still stamps the unavailable label for a long cooldown (401/402)", async () => {
    const result = await markAccountUnavailable(
      "conn-1",
      401,
      "invalid api key",
      "openai-compatible-chat-x",
      "deepseek-v4.1-flash",
    );
    expect(result.shouldFallback).toBe(true);
    const update = updateProviderConnection.mock.calls[0][1];
    expect(update.testStatus).toBe("unavailable");
  });
});
