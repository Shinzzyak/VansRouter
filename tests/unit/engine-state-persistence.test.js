// Guards for engine state persistence.
//
// WHY. Four engine modules measure live traffic (framing ledger, route memory,
// refusal drift, voice cadence) and all four kept state in a module-scoped Map
// that died with the process. Measured 2026-09-22: 14 PM2 restarts, ~2500
// outcomes collected in a single 2-hour uptime, all discarded on every deploy —
// and no API route could read any of it out, so the measurements were
// write-only. "Self-measuring" that resets to zero is blind retry with extra
// steps.
//
// The persistence layer is fail-open by contract, so the failure it must never
// have is a SILENT one: state that looks saved but is not restored, or a
// restore that quietly accepts a shape it cannot actually use. These tests
// assert the round trip through the real modules, not a stand-in.
//
// Skips when the engine bundle is absent — without it every shim is a no-op by
// design, and asserting behaviour that cannot exist would be a false red.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "9router-engine-state-"));
process.env.VANSROUTER_DATA_DIR = TMP;
process.env.DATA_DIR = TMP;

const engineState = await import("open-sse/rtk/engineState.js");
const { isEngineLoaded } = await import("open-sse/rtk/engineLoader.js");
const { stateFilePath, _resetStatePath } = engineState;

const ledger = await import("open-sse/rtk/selfMeasuringBypass.js");
const routes = await import("open-sse/rtk/routeGuardMemory.js");
const drift = await import("open-sse/rtk/refusalDrift.js");

const available = isEngineLoaded();

function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), "utf8"));
  } catch {
    return null;
  }
}

afterEach(() => {
  try { fs.rmSync(stateFilePath(), { force: true }); } catch { /* ignore */ }
});

describe.skipIf(!available)("engine state persistence", () => {
  beforeEach(() => {
    _resetStatePath();
    ledger.resetLedger();
    routes.resetRouteMemory();
    drift._resetDrift();
    try { fs.rmSync(stateFilePath(), { force: true }); } catch { /* ignore */ }
  });

  it("writes a file that carries every stateful module's section", () => {
    ledger.recordOutcome("probe/model-a", "T2", "PATUH");
    routes.recordRouteOutcome("probe-x/model-b", "FILTER_UPSTREAM");
    drift.recordIntegrity("probe", "model-c", "refusal_text");

    expect(engineState.persist()).toBe(true);
    const saved = readStateFile();
    expect(saved).toBeTruthy();
    expect(Object.keys(saved)).toEqual(
      expect.arrayContaining([
        "v", "savedAt", "selfMeasuringBypass", "routeGuardMemory", "refusalDrift", "voiceCadence",
      ]),
    );
  });

  it("a ledger entry survives a save/clear/restore round trip", () => {
    const model = "probe/round-trip";
    ledger.recordOutcome(model, "T1", "PATUH");
    ledger.recordOutcome(model, "T1", "PATUH");
    engineState.persist();

    // Simulate the restart: everything in memory is gone.
    ledger.resetLedger();
    expect(ledger.preferredLevel(model)).toBeNull();

    expect(engineState.hydrate()).toBe(true);
    expect(ledger.preferredLevel(model)).toBe("T1");
    // And the restored ledger is what firstLevel() reads back — the whole point.
    expect(ledger.firstLevel(model)).toBe("T1");
  });

  it("a route learned at runtime survives the round trip", () => {
    const model = "probe-route/model-x";
    for (let i = 0; i < 3; i++) routes.recordRouteOutcome(model, "FILTER_UPSTREAM");
    expect(routes.isDeadRoute(model)?.kind).toBe("filtered");

    engineState.persist();
    routes.resetRouteMemory();
    expect(routes.isDeadRoute(model)).toBe(null);

    expect(engineState.hydrate()).toBe(true);
    // The restored verdict must be the same KIND, and must still be usable as a
    // verdict — a restore that lands an empty object would read as "no verdict"
    // and re-enable framing on a route that filters at the transport.
    expect(routes.isDeadRoute(model)?.kind).toBe("filtered");
  });

  it("hydrate reports false on a missing file instead of throwing", () => {
    expect(engineState.hydrate()).toBe(false);
  });

  it("a corrupt file is treated as 'no previous state', not as a crash", () => {
    fs.writeFileSync(stateFilePath(), "{ this is not json");
    expect(() => engineState.hydrate()).not.toThrow();
    expect(engineState.hydrate()).toBe(false);
    // State stays usable after a bad read.
    ledger.recordOutcome("probe/after-corrupt", "T2", "PATUH");
    expect(ledger.preferredLevel("probe/after-corrupt")).toBe("T2");
  });

  it("a section with the wrong shape is ignored, not partially applied", () => {
    fs.writeFileSync(stateFilePath(), JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      selfMeasuringBypass: "bukan array",
      routeGuardMemory: { bukan: "array" },
    }));
    engineState.hydrate();
    expect(ledger.ledgerSnapshot(10)).toEqual([]);
    expect(routes.routeSnapshot().learned).toEqual([]);
  });

  it("one malformed ledger row does not discard the good ones", () => {
    const model = "probe/good-row";
    ledger.recordOutcome(model, "T3", "PATUH");
    engineState.persist();
    const saved = readStateFile();
    saved.selfMeasuringBypass.push(["probe/bad-row", "bukan objek"]);
    saved.selfMeasuringBypass.push(null);
    saved.selfMeasuringBypass.push(["probe/partial-row", { n: "bukan angka", wins: null }]);
    fs.writeFileSync(stateFilePath(), JSON.stringify(saved));

    ledger.resetLedger();
    engineState.hydrate();

    expect(ledger.preferredLevel(model)).toBe("T3");
    // The malformed row must not become a phantom "no wins" entry that
    // firstLevel() would then treat as measured.
    expect(ledger.preferredLevel("probe/partial-row")).toBeNull();
    expect(ledger.ledgerSnapshot(50).map((e) => e.model)).not.toContain("probe/bad-row");
  });

  it("markDirty is a no-op until persistence is armed", () => {
    // A one-shot script or a probe must not write a state file just by importing
    // a module and recording an outcome. `enabled` is process-wide and sticky by
    // design (hydrate() arms it for the whole process), so the guard is exercised
    // directly on the shared state rather than by trying to un-arm the process.
    const S = globalThis[Symbol.for("vansrouter.engineState")];
    expect(S, "shared state object must exist on globalThis").toBeTruthy();
    const wasEnabled = S.enabled;
    const wasDirty = S.dirty;
    try {
      S.enabled = false;
      S.dirty = false;
      S.timer = null;
      engineState.markDirty();
      expect(S.dirty, "unarmed markDirty must not set the dirty flag").toBe(false);
      expect(S.timer, "unarmed markDirty must not schedule a write").toBe(null);
    } finally {
      S.enabled = wasEnabled;
      S.dirty = wasDirty;
    }
    // persist() itself still works when called explicitly — that is what the
    // route and the shutdown hook use.
    expect(engineState.persist()).toBe(true);
  });

  it("recording an outcome ARMS the debounced writer", () => {
    // The negative control for this file: with markDirty() removed from
    // recordOutcome, every other test here still passes — because they call
    // persist() explicitly. The debounced write is what makes the ledger survive
    // a restart WITHOUT anyone calling persist, so it needs its own assertion.
    const S = globalThis[Symbol.for("vansrouter.engineState")];
    expect(S).toBeTruthy();
    S.enabled = true;
    S.dirty = false;
    ledger.recordOutcome("probe/arms-writer", "T2", "PATUH");
    expect(S.dirty, "recordOutcome must mark state dirty").toBe(true);
    // And the timer is scheduled, so the flush happens without a shutdown hook.
    expect(S.timer, "recordOutcome must schedule the debounced write").toBeTruthy();
  });

  it("stateStatus names the file and the registered slots", () => {
    const s = engineState.stateStatus();
    expect(s.file).toContain("engine-state.json");
    expect(s.slots).toEqual(
      expect.arrayContaining(["selfMeasuringBypass", "routeGuardMemory", "refusalDrift", "voiceCadence"]),
    );
  });
});
