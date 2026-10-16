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

describe("sentinelRows — answered is its own axis", () => {
  // The contract counts come from the MODEL's own output (the tap sits upstream
  // of the brand gate), so a model that never writes its own brand line can be
  // perfectly healthy. "Did it answer at all" is a different question and needs
  // its own number — the roster lists models that cannot be answered.
  it("separates 'never self-branded' from 'did not answer'", () => {
    const rows = sentinelRows(
      driftModule({
        "a/m": { total: 50, refusalRate: 0, brandViolationRate: 0.6, drifted: true, driftAxes: ["brand"], counts: { ok: 20, missing_brand: 30, total: 50 } },
        "b/m": { total: 50, refusalRate: 0, drifted: false, driftAxes: [], counts: { ok: 30, empty: 20, total: 50 } },
      }),
    );
    const [a, b] = rows; // DRIFT sorts first
    expect(a.answered).toBe(50);      // leaned on the gate every time, answered every time
    expect(a.answeredRate).toBe(1);
    expect(b.answered).toBe(30);      // self-branded what it answered; 20 came back empty
    expect(b.answeredRate).toBeCloseTo(0.6, 5);
  });

  it("counts a filtered output as unanswered, not as an answer", () => {
    const rows = sentinelRows(driftModule({ "p/m": { total: 10, counts: { ok: 4, output_filtered: 6, total: 10 } } }));
    expect(rows[0].answered).toBe(4);
  });

  it("clamps at zero on a torn window", () => {
    // `total` can lag its counts while a window is being appended.
    const rows = sentinelRows(driftModule({ "p/m": { total: 2, counts: { ok: 0, empty: 5, total: 2 } } }));
    expect(rows[0].answered).toBe(0);
  });
});

describe("sentinelRows — the label keeps the tail", () => {
  // The dashboard truncated from the RIGHT, so six distinct multi-slash keys
  // rendered as the same string on screen. The distinguishing part is the tail.
  it("a long key gets a tail-preserving label and keeps the full key", () => {
    const key = "openai-compatible-chat-a594f060-f951-4bf9-b753-653786ec0d1";
    const rows = sentinelRows(driftModule({ [key]: { total: 1, counts: { ok: 1, total: 1 } } }));
    expect(rows[0].model).toBe(key);
    expect(rows[0].shortModel.length).toBeLessThanOrEqual(44);
    expect(key.endsWith(rows[0].shortModel.replace("…", ""))).toBe(true);
    expect(rows[0].shortModel.startsWith("…")).toBe(true);
  });

  it("a short key is labelled whole, with no ellipsis", () => {
    const rows = sentinelRows(driftModule({ "zai/glm-5.3-flash": { total: 1, counts: { ok: 1, total: 1 } } }));
    expect(rows[0].shortModel).toBe("zai/glm-5.3-flash");
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
    expect(t.answeredRate).toBeNull();
  });

  it("totals answered beside judged, from the same rows", () => {
    const t = sentinelTotals(
      sentinelRows(driftModule({ "a/m": { total: 100, counts: { ok: 70, empty: 20, output_filtered: 10, total: 100 } } })),
    );
    expect(t.judged).toBe(100);
    expect(t.answered).toBe(70);
    expect(t.answeredRate).toBeCloseTo(0.7, 5);
  });
});
