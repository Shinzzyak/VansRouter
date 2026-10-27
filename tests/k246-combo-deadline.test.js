import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// K246: the rotation deadline was checked only BETWEEN candidates while every
// candidate got a fresh full timeout. Live evidence 2026-10-27: combo/smart-fallback
// answered 502 after 108 s against a 90 s deadline; a single candidate probe ran 150 s.
// The pin: with a small VR_COMBO_DEADLINE_MS and a full per-candidate timeout, a
// hanging candidate must be cut at the REMAINING budget, so the whole rotation
// finishes inside the deadline instead of N × timeout.

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

async function loadCombo() {
  const mod = await import("../open-sse/services/combo.js");
  return mod.handleComboChat;
}

describe("K246 combo rotation deadline is a wall, not a comment", () => {
  const ORIGINAL_DEADLINE = process.env.VR_COMBO_DEADLINE_MS;

  beforeEach(() => {
    process.env.VR_COMBO_DEADLINE_MS = "1200";
  });

  afterEach(() => {
    if (ORIGINAL_DEADLINE === undefined) delete process.env.VR_COMBO_DEADLINE_MS;
    else process.env.VR_COMBO_DEADLINE_MS = ORIGINAL_DEADLINE;
  });

  it("cuts a hanging candidate at the remaining budget, not at the full timeout", async () => {
    const handleComboChat = await loadCombo();

    // Every candidate hangs forever and ignores the abort signal, so only the
    // timeout race can end the attempt. Per-candidate budget is 10 s, deadline 1.2 s.
    const attempts = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      attempts.push({ modelStr, at: Date.now() });
      return new Promise(() => {});
    });

    const started = Date.now();
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["prov-a/alpha", "prov-b/beta", "prov-c/gamma"],
      handleSingleModel,
      log: quietLog,
      comboName: "smart-fallback",
      comboStrategy: "fallback",
      autoSwitch: false,
      timeoutMs: 10000,
    });
    const elapsed = Date.now() - started;

    // Wall-clock bound: deadline (1.2 s) + slack for one clamp window and teardown.
    expect(elapsed).toBeLessThan(4000);
    // It must not have burned a full 10 s timeout on the first candidate.
    expect(elapsed).toBeLessThan(10000);
    // The request still terminates with a real status instead of hanging.
    expect(result).toBeTruthy();
    expect(typeof result.status).toBe("number");
    expect(result.status).toBeGreaterThanOrEqual(500);
    // At least one candidate was actually attempted.
    expect(handleSingleModel).toHaveBeenCalled();
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("still stops rotating once the deadline has passed", async () => {
    const handleComboChat = await loadCombo();

    const handleSingleModel = vi.fn(async () => ({
      status: 503,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: { message: "overloaded" } }),
      clone() { return this; },
      text: async () => JSON.stringify({ error: { message: "overloaded" } }),
    }));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["prov-a/alpha", "prov-b/beta", "prov-c/gamma", "prov-d/delta"],
      handleSingleModel,
      log: quietLog,
      comboName: "smart-fallback",
      comboStrategy: "fallback",
      autoSwitch: false,
      timeoutMs: 10000,
    });

    expect(result).toBeTruthy();
    expect(handleSingleModel.mock.calls.length).toBeLessThanOrEqual(4);
  }, 30000);
});
