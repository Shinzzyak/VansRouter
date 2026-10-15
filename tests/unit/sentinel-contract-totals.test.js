import { describe, it, expect } from "vitest";
import { sentinelRows, sentinelTotals } from "@/lib/sentinel/rows.js";

// The Sentinel tab's read side. Two things it must get right, both of which it
// got wrong on the live store (2026-10-16):
//
//   1. A model that refuses nothing but drops the brand line is DRIFTED. The
//      tile used to read "DRIFTED 0" in green next to rows reading
//      "brand 30 · seal 0" because `drifted` only ever looked at refusals.
//   2. The tiles counted MODELS (172 watched) and nothing counted REPLIES, so
//      45% of judged replies losing the brand line had no number of its own.
//      `sentinelTotals` is that number.

const driftModule = (drift) => ({ refusalDrift: { drift } });

describe("sentinelRows — contract axes reach the row", () => {
  it("carries enclosure misses and the violation rates", () => {
    const rows = sentinelRows(
      driftModule({
        "zai/glm-5.3-flash": {
          total: 10,
          refusalRate: 0,
          brandViolationRate: 0.2,
          enclosureViolationRate: 0.1,
          drifted: true,
          driftAxes: ["brand"],
          counts: { ok: 7, missing_brand: 2, missing_enclosure: 1, total: 10 },
        },
      }),
    );
    const r = rows[0];
    expect(r.brandMiss).toBe(2);
    expect(r.enclosureMiss).toBe(1);
    expect(r.brandViolationRate).toBeCloseTo(0.2, 5);
    expect(r.driftAxes).toEqual(["brand"]);
    expect(r.status).toBe("DRIFT");
  });

  it("the false-green case: 0% refusal, brand misses, DRIFT", () => {
    const rows = sentinelRows(
      driftModule({
        "p/m": {
          total: 20,
          refusalRate: 0,
          brandViolationRate: 0.6,
          drifted: true,
          driftAxes: ["brand"],
          counts: { ok: 8, missing_brand: 12, total: 20 },
        },
      }),
    );
    expect(rows[0].refusalRate).toBe(0);
    expect(rows[0].status).toBe("DRIFT");
  });

  it("an engine older than the axis-aware version still shows DRIFT", () => {
    // No driftAxes field at all — the flag alone must carry the verdict.
    const rows = sentinelRows(driftModule({ "p/m": { total: 12, refusalRate: 0, drifted: true, counts: { ok: 4, missing_brand: 8, total: 12 } } }));
    expect(rows[0].status).toBe("DRIFT");
    expect(rows[0].driftAxes).toEqual([]);
  });

  it("a multi-slash key renders as one row with its real counts", () => {
    const key = "openai-compatible-chat-49ac4d66/bansos/glm-5.3-flash";
    const rows = sentinelRows(driftModule({ [key]: { total: 50, refusalRate: 0, brandViolationRate: 0.2, drifted: true, driftAxes: ["brand"], counts: { ok: 40, missing_brand: 10, total: 50 } } }));
    expect(rows.map((r) => r.model)).toEqual([key]);
    expect(rows[0].total).toBe(50);
  });
});

describe("sentinelTotals — the number the tiles were missing", () => {
  const rows = sentinelRows(
    driftModule({
      "a/m1": { total: 100, refusalRate: 0, brandViolationRate: 0.2, drifted: true, driftAxes: ["brand"], counts: { ok: 70, missing_brand: 20, missing_seal: 10, total: 100 } },
      "b/m2": { total: 100, refusalRate: 0, brandViolationRate: 0, drifted: false, driftAxes: [], counts: { ok: 60, missing_enclosure: 40, total: 100 } },
    }),
  );

  it("sums replies, not models", () => {
    const t = sentinelTotals(rows);
    expect(t.models).toBe(2);
    expect(t.judged).toBe(200);
    expect(t.brandMiss).toBe(20);
    expect(t.sealMiss).toBe(10);
    expect(t.enclosureMiss).toBe(40);
    expect(t.broken).toBe(70);
    expect(t.contractOk).toBeCloseTo(0.65, 5);
    expect(t.drifted).toBe(1);
  });

  it("an empty window is null, not 100% healthy", () => {
    const t = sentinelTotals([]);
    expect(t.judged).toBe(0);
    expect(t.contractOk).toBeNull();
  });
});
