import { describe, it, expect } from "vitest";
import {
  synthesisReadiness,
  SYNTHESIS_BLOCK,
} from "@/lib/engine/synthesisReadiness.js";

const L = ["T2", "T1", "T3", "T4"];

const levels = (spec) =>
  Object.fromEntries(L.map((l) => [l, { tries: spec[l]?.[0] || 0, wins: spec[l]?.[1] || 0 }]));

describe("synthesisReadiness (K168)", () => {
  it("reports unavailable instead of empty when the bundle is missing", () => {
    const r = synthesisReadiness({ available: false, models: [] }, { levels: L });
    expect(r.available).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.ready).toBe(0);
  });

  it("names untried levels as the blocker", () => {
    const r = synthesisReadiness(
      { available: true, models: [{ model: "a", n: 3, levels: levels({ T2: [2, 0] }) }] },
      { levels: L }
    );
    expect(r.rows[0].missing).toEqual(["T1", "T3", "T4"]);
    expect(r.rows[0].blocked).toBe(SYNTHESIS_BLOCK.LEVELS_UNUSED);
    expect(r.rows[0].ready).toBe(false);
  });

  it("does not call a winning model blocked", () => {
    const r = synthesisReadiness(
      {
        available: true,
        models: [
          {
            model: "b",
            n: 9,
            levels: levels({ T2: [3, 1], T1: [2, 1], T3: [2, 0], T4: [2, 0] }),
          },
        ],
      },
      { levels: L }
    );
    expect(r.rows[0].missing).toEqual([]);
    expect(r.rows[0].won).toBe(2);
    expect(r.rows[0].blocked).toBe(SYNTHESIS_BLOCK.WON);
    expect(r.ready).toBe(0);
  });

  it("flags the real trigger: all four burned", () => {
    const r = synthesisReadiness(
      {
        available: true,
        models: [
          { model: "c", n: 12, levels: levels({ T2: [3, 0], T1: [3, 0], T3: [3, 0], T4: [3, 0] }) },
        ],
      },
      { levels: L }
    );
    expect(r.rows[0].burned).toBe(true);
    expect(r.rows[0].ready).toBe(true);
    expect(r.ready).toBe(1);
    expect(r.rows[0].blocked).toBe(SYNTHESIS_BLOCK.REFUSAL_UNKNOWN);
  });

  it("keeps zero-evidence models out of the ready count", () => {
    const r = synthesisReadiness(
      { available: true, models: [{ model: "d", n: 0, levels: levels({}) }] },
      { levels: L }
    );
    expect(r.rows[0].blocked).toBe(SYNTHESIS_BLOCK.NO_EVIDENCE);
    expect(r.ready).toBe(0);
  });

  it("sorts by sample count so the reader sees the loudest model first", () => {
    const r = synthesisReadiness(
      {
        available: true,
        models: [
          { model: "small", n: 1, levels: levels({}) },
          { model: "big", n: 40, levels: levels({}) },
        ],
      },
      { levels: L }
    );
    expect(r.rows.map((x) => x.model)).toEqual(["big", "small"]);
  });
});
