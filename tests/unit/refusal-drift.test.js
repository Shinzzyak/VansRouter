import { describe, it, expect, beforeEach } from "vitest";
import { recordIntegrity, getDrift, getAllDrift, _resetDrift } from "open-sse/rtk/refusalDrift.js";
import { INTEGRITY } from "open-sse/rtk/responseIntegrity.js";
import { engineAvailable } from "./_engineAvailable.js";

describe.skipIf(!engineAvailable())("refusalDrift tracker", () => {
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

  // ── the contract axes ────────────────────────────────────────────────────
  // Before these, `drifted` could only see refusals: a model that dropped the
  // brand line in 60% of replies read `drifted: false` and the Sentinel tile
  // read "DRIFTED 0" in green. Live store 2026-10-16: 1454 judged, 191
  // missing_brand, 141 missing_enclosure, 0 flagged.

  it("brand violation ALONE flags drift", () => {
    for (let i = 0; i < 8; i++) recordIntegrity("zai", "glm-5.3-flash", INTEGRITY.OK);
    for (let i = 0; i < 2; i++) recordIntegrity("zai", "glm-5.3-flash", INTEGRITY.MISSING_BRAND);
    const d = getDrift("zai", "glm-5.3-flash");
    expect(d.refusalRate).toBe(0);
    expect(d.brandViolationRate).toBeCloseTo(0.2, 5);
    expect(d.drifted).toBe(true);
    expect(d.driftAxes).toEqual(["brand"]);
  });

  it("missing_seal counts on the brand axis; enclosure has its own", () => {
    for (let i = 0; i < 8; i++) recordIntegrity("p", "m", INTEGRITY.OK);
    recordIntegrity("p", "m", INTEGRITY.MISSING_SEAL);
    recordIntegrity("p", "m", INTEGRITY.MISSING_ENCLOSURE);
    const d = getDrift("p", "m");
    expect(d.brandViolationRate).toBeCloseTo(0.1, 5); // seal only
    expect(d.enclosureViolationRate).toBeCloseTo(0.1, 5);
    expect(d.drifted).toBe(false); // neither axis reaches 0.15 at 10 samples
    expect(d.driftAxes).toEqual([]);
  });

  it("MIN_SAMPLES gates every axis, not just refusal", () => {
    recordIntegrity("p", "m", INTEGRITY.MISSING_BRAND);
    recordIntegrity("p", "m", INTEGRITY.MISSING_BRAND);
    const d = getDrift("p", "m");
    expect(d.brandViolationRate).toBe(1);
    expect(d.drifted).toBe(false); // 2 samples
  });

  it("two axes at once are both named", () => {
    for (let i = 0; i < 6; i++) recordIntegrity("p", "m", INTEGRITY.OK);
    for (let i = 0; i < 2; i++) recordIntegrity("p", "m", INTEGRITY.MISSING_BRAND);
    for (let i = 0; i < 2; i++) recordIntegrity("p", "m", INTEGRITY.REFUSAL);
    expect(getDrift("p", "m").driftAxes.sort()).toEqual(["brand", "refusal"]);
  });

  // ── the key is read from the map, never rebuilt from its parts ────────────
  // 26 of 108 keys on the live store are multi-slash (`…/bansos/glm-5.3-flash`,
  // `nvidia/z-ai/…`) and carry 27.6% of all judged replies. The old
  // `getAllDrift` split the key on "/" and kept two halves, so every one of
  // those lookups missed and reported `total: 0`.

  it("getAllDrift keeps multi-slash keys intact", () => {
    const provider = "openai-compatible-chat-49ac4d66-8eaa-41af-be38-1a65f1ceb5d3";
    const model = "bansos/glm-5.3-flash";
    for (let i = 0; i < 40; i++) recordIntegrity(provider, model, INTEGRITY.OK);
    for (let i = 0; i < 10; i++) recordIntegrity(provider, model, INTEGRITY.MISSING_BRAND);

    const all = getAllDrift();
    const key = `${provider}/${model}`;
    expect(Object.keys(all)).toEqual([key]); // no truncated sibling
    expect(all[key].total).toBe(50); // used to be 0
    expect(all[key].drifted).toBe(true);
  });

  it("getAllDrift and getDrift never disagree", () => {
    for (let i = 0; i < 9; i++) recordIntegrity("nvidia", "z-ai/glm-5.3-flash", INTEGRITY.OK);
    recordIntegrity("nvidia", "z-ai/glm-5.3-flash", INTEGRITY.MISSING_SEAL);
    expect(getAllDrift()["nvidia/z-ai/glm-5.3-flash"]).toEqual(getDrift("nvidia", "z-ai/glm-5.3-flash"));
  });

  it("fail-open on garbage input (no throw)", () => {
    expect(() => { recordIntegrity(undefined, undefined, INTEGRITY.OK); }).not.toThrow();
  });
});
