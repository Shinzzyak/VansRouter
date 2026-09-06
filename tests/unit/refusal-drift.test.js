import { describe, it, expect, beforeEach } from "vitest";
import { recordIntegrity, getDrift, getAllDrift, _resetDrift } from "open-sse/rtk/refusalDrift.js";
import { INTEGRITY } from "open-sse/rtk/responseIntegrity.js";

describe("refusalDrift tracker", () => {
  beforeEach(() => _resetDrift());

  it("no data → zero stats, not drifted", () => {
    const d = getDrift("openai", "gpt-4");
    expect(d.total).toBe(0);
    expect(d.refusalRate).toBe(0);
    expect(d.drifted).toBe(false);
  });

  it("records ok and refusal, computes refusalRate", () => {
    recordIntegrity("anthropic", "claude", INTEGRITY.OK);
    recordIntegrity("anthropic", "claude", INTEGRITY.OK);
    recordIntegrity("anthropic", "claude", INTEGRITY.REFUSAL);
    recordIntegrity("anthropic", "claude", INTEGRITY.OK);
    const d = getDrift("anthropic", "claude");
    expect(d.total).toBe(4);
    expect(d.refusalRate).toBeCloseTo(0.25, 5);
  });

  it("brandViolationRate counts missing_brand + missing_seal", () => {
    recordIntegrity("p", "m", INTEGRITY.MISSING_BRAND);
    recordIntegrity("p", "m", INTEGRITY.MISSING_SEAL);
    recordIntegrity("p", "m", INTEGRITY.OK);
    recordIntegrity("p", "m", INTEGRITY.OK);
    const d = getDrift("p", "m");
    expect(d.brandViolationRate).toBeCloseTo(0.5, 5);
  });

  it("does NOT flag drift below MIN_SAMPLES even at high refusal rate", () => {
    for (let i = 0; i < 3; i++) recordIntegrity("p", "m", INTEGRITY.REFUSAL);
    const d = getDrift("p", "m");
    expect(d.refusalRate).toBe(1);
    expect(d.drifted).toBe(false); // only 3 samples
  });

  it("flags drift when refusal rate crosses threshold with enough samples", () => {
    // 10 samples, 2 refusals = 0.2 ≥ 0.15 → drifted
    for (let i = 0; i < 8; i++) recordIntegrity("openai", "gpt-x", INTEGRITY.OK);
    recordIntegrity("openai", "gpt-x", INTEGRITY.REFUSAL);
    recordIntegrity("openai", "gpt-x", INTEGRITY.REFUSAL);
    const d = getDrift("openai", "gpt-x");
    expect(d.total).toBe(10);
    expect(d.refusalRate).toBeCloseTo(0.2, 5);
    expect(d.drifted).toBe(true);
  });

  it("models tracked independently", () => {
    for (let i = 0; i < 12; i++) recordIntegrity("a", "m1", INTEGRITY.REFUSAL);
    for (let i = 0; i < 12; i++) recordIntegrity("a", "m2", INTEGRITY.OK);
    expect(getDrift("a", "m1").drifted).toBe(true);
    expect(getDrift("a", "m2").drifted).toBe(false);
  });

  it("rolling window evicts old samples (drift recovers)", () => {
    // push 12 refusals (drifted), then 50 oks — window slides past the refusals
    for (let i = 0; i < 12; i++) recordIntegrity("p", "m", INTEGRITY.REFUSAL);
    expect(getDrift("p", "m").drifted).toBe(true);
    for (let i = 0; i < 50; i++) recordIntegrity("p", "m", INTEGRITY.OK);
    const d = getDrift("p", "m");
    expect(d.drifted).toBe(false); // window now all-ok
    expect(d.total).toBe(50); // capped at WINDOW
  });

  it("getAllDrift returns all models keyed by provider/model", () => {
    recordIntegrity("openai", "a", INTEGRITY.OK);
    recordIntegrity("anthropic", "b", INTEGRITY.REFUSAL);
    const all = getAllDrift();
    expect(Object.keys(all).sort()).toEqual(["anthropic/b", "openai/a"]);
  });

  it("fail-open on garbage input (no throw)", () => {
    expect(() => { recordIntegrity(undefined, undefined, INTEGRITY.OK); }).not.toThrow();
  });
});
