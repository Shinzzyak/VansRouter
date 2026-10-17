// Refusal counter (2026-10-17 audit).
//
// WHY. 18,028 assistant messages in the default profile's state.db held ZERO
// refusal-shaped text. Refusals were being escalated into real answers by
// bypassEngine and therefore left no trace: "it sometimes refuses" could not be
// tested. These three counters are the missing instrument.
import { describe, it, expect, beforeEach } from "vitest";
import { recordRefusalMetric, getRefusalMetrics, _resetRefusalMetrics } from "../../open-sse/rtk/refusalMetrics.js";

describe("refusalMetrics", () => {
  beforeEach(() => _resetRefusalMetrics());

  it("counts each stage independently", () => {
    recordRefusalMetric("detected", { provider: "p", model: "m" });
    recordRefusalMetric("detected", { provider: "p", model: "m" });
    recordRefusalMetric("retried", { provider: "p", model: "m" });
    const m = getRefusalMetrics();
    expect(m.detected).toBe(2);
    expect(m.retried).toBe(1);
    expect(m.shipped).toBe(0);
  });

  it("ignores unknown kinds instead of inventing a counter", () => {
    recordRefusalMetric("banana");
    const m = getRefusalMetrics();
    expect(Object.keys(m).filter((k) => k !== "file")).toEqual(["detected", "retried", "shipped"]);
  });

  it("survives a broken sink — diagnostics never throw into a request", () => {
    expect(() => recordRefusalMetric("detected", { provider: "p" })).not.toThrow();
    expect(getRefusalMetrics().detected).toBe(1);
  });
});
