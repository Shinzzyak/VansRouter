// Guard for the permanent-balance verdict.
//
// FINDING (2026-09-22). One prepaid relay (`nfh` → api.inferhub.dev) answered
// every request with:
//   {"error":{"message":"balance too low for this request — deposit USDC to
//             continue","type":"insufficient_balance"}}
// It was the FIRST candidate of the smart-fallback combo, so every request paid
// ~7.8s of latency to learn the deposit was empty. Measured over one window:
// 142 attempts, 64.9 minutes of pure waste, and 72 of those attempts were
// immediately followed by a success on another provider.
//
// Why nothing caught it: 402 already has a status rule, but it grants a 2-MINUTE
// cooldown — right for a rate/quota blip, wrong for an empty wallet. The account
// came straight back on the next request. The existing autoclaw detector had the
// right patterns but was hard-gated on `provider === "autoclaw"`.
//
// These tests pin two things: the verdict fires on a real balance message, and it
// does NOT fire on the error classes that must keep their existing behaviour.
import { describe, it, expect } from "vitest";
import {
  isPermanentBalanceExhausted,
  isAutoclawInsufficientBalance,
  buildAutoclawBalanceExhaustedUpdate,
} from "../../open-sse/services/accountFallback.js";

// The literal body recorded in production.
const REAL_402_BODY = JSON.stringify({
  error: {
    message: "balance too low for this request — deposit USDC to continue",
    type: "insufficient_balance",
  },
});

describe("isPermanentBalanceExhausted — fires on a dead wallet", () => {
  it("recognises the real relay body", () => {
    expect(isPermanentBalanceExhausted(REAL_402_BODY)).toBe(true);
  });

  it("recognises it as a raw string too, not only as JSON", () => {
    expect(isPermanentBalanceExhausted("insufficient_balance")).toBe(true);
    expect(isPermanentBalanceExhausted("your balance is too low")).toBe(true);
    expect(isPermanentBalanceExhausted("please recharge to continue")).toBe(true);
  });

  it("is provider-agnostic — the point of the fix", () => {
    // The autoclaw detector must stay scoped to autoclaw; this one must not be.
    expect(isAutoclawInsufficientBalance("nfh", REAL_402_BODY)).toBe(false);
    expect(isPermanentBalanceExhausted(REAL_402_BODY)).toBe(true);
  });

  it("accepts an object as well as a string", () => {
    expect(isPermanentBalanceExhausted(JSON.parse(REAL_402_BODY))).toBe(true);
  });

  it("empty / missing input is not a balance failure", () => {
    expect(isPermanentBalanceExhausted("")).toBe(false);
    expect(isPermanentBalanceExhausted(null)).toBe(false);
    expect(isPermanentBalanceExhausted(undefined)).toBe(false);
  });
});

describe("isPermanentBalanceExhausted — does NOT swallow other error classes", () => {
  // Each of these has its own handling and must not be turned into a permanent
  // deactivation. A false positive here takes a HEALTHY account out of rotation
  // until a human notices, which is far worse than the waste it prevents.
  const MUST_NOT_MATCH = [
    ["rate limit", "rate limit exceeded"],
    ["quota", "you exceeded your current quota"],
    ["daily quota", "daily limit reached, resets at 00:00 UTC"],
    ["auth", "invalid api key"],
    ["content safety", "the model's provider rejected this request"],
    ["codebuddy 11140", '{"code":11140,"msg":"request illegal"}'],
    ["overloaded", "the server is overloaded, try again later"],
    ["kiro quota", "monthly quota exhausted"],
    ["5xx", "bad gateway"],
  ];

  it.each(MUST_NOT_MATCH)("does not fire on %s", (_label, text) => {
    expect(isPermanentBalanceExhausted(text)).toBe(false);
  });
});

describe("buildAutoclawBalanceExhaustedUpdate", () => {
  it("deactivates the connection — no cooldown can outlive it", () => {
    const update = buildAutoclawBalanceExhaustedUpdate(new Date("2026-09-22T00:00:00Z"));
    expect(update.isActive).toBe(false);
    expect(update.testStatus).toBe("insufficient_balance");
    expect(update.errorCode).toBe(402);
    expect(update.balanceExhaustedAt).toBe("2026-09-22T00:00:00.000Z");
  });
});
