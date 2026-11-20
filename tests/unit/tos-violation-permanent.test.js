import { describe, expect, it } from "vitest";
import {
  isPermanentTosViolation,
  buildTosViolationUpdate,
  isPermanentBalanceExhausted,
} from "../../open-sse/services/accountFallback.js";

// Ported from 9router-go internal/connlimit/connlimit.go:
//   func IsTOSViolation(status int, body []byte) bool {
//     if status != http.StatusForbidden || len(body) == 0 { return false }
//     return containsTOSViolation(body)   // case-insensitive "tos_violation"
//   }
// and its caller RecordFailure, which returns early for this case:
//   "permanent: #996 handles it, never charge backoff or breaker"
//
// Before the port a 403 carrying tos_violation fell through to the generic 403
// status rule (COOLDOWN.long) and fed the breaker, so the banned connection was
// re-selected after every cooldown and failed identically forever.

describe("isPermanentTosViolation", () => {
  it("matches a 403 whose body carries tos_violation", () => {
    expect(isPermanentTosViolation(403, '{"error":{"code":"tos_violation"}}')).toBe(true);
  });

  it("is case-insensitive, like upstream containsFolded", () => {
    expect(isPermanentTosViolation(403, '{"error":{"code":"TOS_VIOLATION"}}')).toBe(true);
    expect(isPermanentTosViolation(403, "Tos_Violation detected")).toBe(true);
  });

  it("accepts an object body (errorText is often parsed JSON)", () => {
    expect(isPermanentTosViolation(403, { error: { code: "tos_violation" } })).toBe(true);
  });

  it("ignores 429 — upstream test asserts a rate limit is not a ban", () => {
    expect(isPermanentTosViolation(429, '{"error":{"code":"tos_violation"}}')).toBe(false);
  });

  it("ignores other statuses", () => {
    for (const s of [200, 400, 401, 402, 500, 503]) {
      expect(isPermanentTosViolation(s, "tos_violation")).toBe(false);
    }
  });

  it("ignores a 403 with an unrelated code — upstream test case", () => {
    expect(isPermanentTosViolation(403, '{"error":{"code":"other"}}')).toBe(false);
  });

  it("ignores empty/absent bodies", () => {
    expect(isPermanentTosViolation(403, "")).toBe(false);
    expect(isPermanentTosViolation(403, null)).toBe(false);
    expect(isPermanentTosViolation(403, undefined)).toBe(false);
  });

  it("does not fire on balance exhaustion (separate permanent path)", () => {
    expect(isPermanentTosViolation(403, "insufficient balance")).toBe(false);
    expect(isPermanentBalanceExhausted("insufficient balance")).toBe(true);
  });
});

describe("buildTosViolationUpdate", () => {
  it("deactivates with the real reason, not a mislabelled empty wallet", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    expect(buildTosViolationUpdate(now)).toEqual({
      isActive: false,
      testStatus: "tos_violation",
      lastErrorType: "tos_violation",
      errorCode: 403,
      tosViolationAt: "2026-11-20T12:00:00.000Z",
    });
  });

  it("carries no timed cooldown — a ban must not expire back into selection", () => {
    const u = buildTosViolationUpdate();
    expect(u.rateLimitedUntil).toBeUndefined();
    expect(u.modelLock).toBeUndefined();
    expect(u.isActive).toBe(false);
  });
});