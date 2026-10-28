// K257 — attribution of a refusal to a provider NODE.
//
// The module's whole job: given verdicts per (provider, model), decide whether the
// wall belongs to the model or to one node's request path. Everything here is
// bookkeeping that must never throw and never reorder without evidence.
import { describe, it, expect, beforeEach } from "vitest";
import { engineAvailable } from "./_engineAvailable.js";
import {
  providerWallId,
  noteNodeVerdict,
  nodesForModel,
  wallVerdict,
  rankNodesForModel,
  explainWall,
  wallSnapshot,
  resetProviderWall,
} from "open-sse/rtk/providerWall.js";

beforeEach(() => resetProviderWall());

const M = "deepseek-v4.1-flash";

// Real engine behaviour: the shim falls back to "unknown" on any runner without
// data/engine/engine.cjs (CI, fresh checkout). Assert the module itself where the
// bundle exists; the fail-open shape is covered separately below, always.
describe.skipIf(!engineAvailable())("K257: provider wall attribution", () => {
  it("calls it a provider-prompt wall when nodes disagree", () => {
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "beta", model: M, verdict: "accepted" });
    noteNodeVerdict({ provider: "beta", model: M, verdict: "accepted" });
    expect(wallVerdict(M)).toBe("provider-prompt");
  });

  it("calls it a model wall when every node refuses", () => {
    for (const p of ["alpha", "beta"]) {
      noteNodeVerdict({ provider: p, model: M, verdict: "refused" });
      noteNodeVerdict({ provider: p, model: M, verdict: "refused" });
    }
    expect(wallVerdict(M)).toBe("model");
  });

  it("stays unknown with one side of evidence", () => {
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "beta", model: M, verdict: "accepted" });
    expect(wallVerdict(M)).toBe("unknown");
  });

  it("stays unknown for a single node", () => {
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    expect(wallVerdict(M)).toBe("unknown");
    expect(nodesForModel(M)).toHaveLength(1);
  });

  it("ranking puts the proven lane first and the proven wall last", () => {
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "beta", model: M, verdict: "accepted" });
    noteNodeVerdict({ provider: "beta", model: M, verdict: "accepted" });
    expect(rankNodesForModel(M, ["alpha", "gamma", "beta"])).toEqual(["beta", "gamma", "alpha"]);
  });

  it("ranking is a no-op without evidence", () => {
    expect(rankNodesForModel(M, ["alpha", "beta"])).toEqual(["alpha", "beta"]);
  });

  it("ignores junk verdicts and junk input instead of throwing", () => {
    expect(noteNodeVerdict(null)).toBeNull();
    expect(noteNodeVerdict({ provider: "alpha", model: M, verdict: "maybe" })).toBeNull();
    expect(noteNodeVerdict({ provider: "", model: M, verdict: "refused" })).toBeNull();
    expect(wallVerdict(null)).toBe("unknown");
    expect(nodesForModel("")).toEqual([]);
    expect(rankNodesForModel(M, null)).toEqual([]);
    expect(explainWall(M)).toContain("no evidence");
  });

  it("keys on provider+model, so the same model on two nodes is two records", () => {
    expect(providerWallId("Alpha", M)).not.toBe(providerWallId("beta", M));
    noteNodeVerdict({ provider: "Alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "beta", model: M, verdict: "refused" });
    expect(Object.keys(wallSnapshot())).toHaveLength(2);
  });

  it("logs a line a human can read", () => {
    noteNodeVerdict({ provider: "alpha", model: M, verdict: "refused" });
    noteNodeVerdict({ provider: "beta", model: M, verdict: "accepted" });
    const line = explainWall(M);
    expect(line).toContain("alpha:0A/1R");
    expect(line).toContain("beta:1A/0R");
  });
});

describe("K257: fail-open without the bundle", () => {
  it("never reorders and never claims a verdict when there is no engine", async () => {
    const { isEngineLoaded } = await import("open-sse/rtk/engineLoader.js");
    if (isEngineLoaded()) return; // covered by the real-engine block above
    expect(rankNodesForModel(M, ["alpha", "beta"])).toEqual(["alpha", "beta"]);
    expect(wallVerdict(M)).toBe("unknown");
    expect(explainWall(M)).toContain("no bundle");
  });
});
