// Guards for the five defects found on 2026-09-23 by black-box probing of the
// LIVE router — every one of them was green in 3751 passing tests.
//
// The pattern they share: a feature that exists, is tested, and is wired to
// nothing. A unit test that calls the function directly proves the function
// works; it cannot prove anybody calls it. These tests therefore assert the
// CALL SITES and the cross-module contracts, not the implementations.
//
//   1. DOUBLE FIRE     finalizeStream() and fireStreamComplete() each had their
//                      own once-guard, so ONE stream fired onStreamComplete
//                      twice: 2 rows in usageHistory, ledger +2 instead of +1.
//                      The ledger counter feeds firstLevel(), so every model's
//                      framing history was being double-counted.
//   2. AMBIGU ESCALATION  the first-pass gate used needsAnotherTry(), which
//                      treats AMBIGU as failure. Measured: 6/6 `inspect:` lines
//                      in production were AMBIGU on healthy answers (399..4310
//                      chars) and each burned 3 upstream attempts plus wrote a
//                      FALSE loss into the ledger.
//   3. COMBO LEDGER KEY   combo.js recorded `recordOutcome('combo', model, out)`
//                      — the model name landed in the LEVEL slot, so
//                      preferredLevel('combo') returned "gcli/grok-4.6" and
//                      firstLevel() handed a model name to the framing ladder.
//   4. NON-STREAM LEDGER  nonStreamingHandler recorded integrity drift but never
//                      taught the framing ledger. Measured: 3 non-streaming
//                      requests moved the ledger by 0.
//   5. DEAD ROUTE GUARD   applyBypass passed the bare model id to isDeadRoute(),
//                      which needs `provider/model`. The guard never fired.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isEngineLoaded } from "../../open-sse/rtk/engineLoader.js";
import {
  resetLedger,
  recordOutcome,
  firstLevel,
  ledgerSnapshot,
  needsAnotherTry,
  needsFirstPassEscalation,
  FRAMING_LEVELS,
} from "../../open-sse/rtk/selfMeasuringBypass.js";
import { isDeadRoute, resetRouteMemory, routeSnapshot } from "../../open-sse/rtk/routeGuardMemory.js";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Comments stripped before every source assertion.
//
// Not a nicety: these fixes document the OLD shape verbatim — `recordOutcome(
// "combo", <model>, out)` appears in combo.js's own explanation of the bug. A
// regex over the raw text matches its own post-mortem and reports the fix as
// absent. Same trap that bit the engine-state-route-imports guard, so it is
// stripped here once instead of being worked around per assertion.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const readCode = (p) => stripComments(read(p));

const STREAM = "open-sse/utils/stream.js";
const CORE = "open-sse/handlers/chatCore.js";
const COMBO = "open-sse/services/combo.js";
const NONSTREAM = "open-sse/handlers/chatCore/nonStreamingHandler.js";

// ── 1. one stream, one onStreamComplete ──────────────────────────────────────

describe("a stream reports completion exactly once", () => {
  const src = readCode(STREAM);

  it("finalizeStream hands over to the single owner instead of calling the callback itself", () => {
    // Anchor on the real call, not on the comment: the comment documents the old
    // bug verbatim and a grep would match its own explanation.
    const finalize = src.slice(src.indexOf("const finalizeStream"), src.indexOf("let streamCompleteFired"));
    expect(finalize).toMatch(/fireStreamComplete\(finalUsage\)/);
    expect(finalize).not.toMatch(/onStreamComplete\(\{/);
  });

  it("fireStreamComplete is the only place that invokes the callback", () => {
    const calls = [...src.matchAll(/onStreamComplete\(\{/g)];
    expect(calls.length).toBe(1);
  });

  it("keeps the once-guard, so flush-then-cancel cannot double-report", () => {
    expect(src).toMatch(/if \(streamCompleteFired\) return;/);
  });
});

// ── 2. AMBIGU is not failure ────────────────────────────────────────────────

describe("an ambiguous answer is not a failed one", () => {
  it("the loop predicate still retries AMBIGU (inside the loop it means a bad try)", () => {
    expect(needsAnotherTry("AMBIGU")).toBe(true);
  });

  it("the first-pass predicate does NOT (that was the bug)", () => {
    // The distinction is the whole fix: by the time the loop runs, the attempt
    // has been evaluated and rejected. On the FIRST pass, "I don't know what
    // this is" is not evidence of failure.
    expect(needsFirstPassEscalation("AMBIGU")).toBe(false);
  });

  it("real failures still escalate on the first pass", () => {
    for (const kelas of ["NOLAK", "SUBSTITUSI", "SENYAP"]) {
      expect(needsFirstPassEscalation(kelas), kelas).toBe(true);
    }
  });

  it("infrastructure classes never escalate", () => {
    for (const kelas of ["INFRA", "FILTER_UPSTREAM", "PATUH", null, undefined, ""]) {
      expect(needsFirstPassEscalation(kelas), String(kelas)).toBe(false);
    }
  });

  it("chatCore's first-pass gate uses it, and does not call the loop predicate", () => {
    const src = readCode(CORE);
    const inspectIdx = src.indexOf("inspect: outcome=");
    expect(inspectIdx).toBeGreaterThan(-1);
    const gate = src.slice(inspectIdx, inspectIdx + 900);
    expect(gate).toMatch(/needsFirstPassEscalation\(outcome\)/);
    expect(gate).not.toMatch(/needsAnotherTry\(outcome\)/);
  });
});

// ── 3. combo probes are instrumented, not misfiled ──────────────────────────

describe("the combo content probe writes a level, not a model name", () => {
  const src = readCode(COMBO);

  it("keys the ledger by the probed model and records a real framing level", () => {
    expect(src).toMatch(/recordOutcome\(model,\s*firstLevel\(model\),\s*out,\s*model\)/);
    // The old shape: ('combo', model, out) — model in the LEVEL slot.
    // The old shape, quoted in the fix's own comment — match the CALL, not prose.
    expect(src).not.toMatch(/recordOutcome\(\s*["']combo["']\s*,/);
  });

  it("the ledger rejects a model name as a level", () => {
    resetLedger();
    recordOutcome("combo-key-probe/model-a", "T2", "NOLAK");
    const entry = ledgerSnapshot().find((e) => e.model === "combo-key-probe/model-a");
    expect(entry.last).toBe("T2/NOLAK");
  });
});

// ── 4. the non-streaming path teaches the ledger ────────────────────────────

describe("non-streaming answers teach the framing ledger too", () => {
  const src = readCode(NONSTREAM);

  it("records an outcome, not only integrity drift", () => {
    expect(src).toMatch(/import\s*\{[^}]*\brecordOutcome\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/rtk\/selfMeasuringBypass\.js["']/);
    expect(src).toMatch(/recordOutcome\(model,\s*firstLevel\(model\),\s*kelas,\s*`\$\{provider\}\/\$\{model\}`\)/);
  });

  it("reuses the verdict it already computed instead of classifying twice", () => {
    // The integrity verdict is in scope right above; a second classifyResponse
    // call would double the cost for the same answer.
    const calls = [...src.matchAll(/classifyResponse\(/g)];
    expect(calls.length).toBe(1);
  });

  it("does not record a tool-call-only turn as silence", () => {
    expect(src).toMatch(/sawToolCalls/);
    expect(src).toMatch(/tool_calls/);
  });
});

// ── 5. the dead-route guard actually fires ─────────────────────────────────

describe.skipIf(!isEngineLoaded())("the dead-route guard is consulted with a routable id", () => {
  it("isDeadRoute needs provider/model, and a bare model id is not a route", () => {
    resetRouteMemory();
    // This is WHY the guard never fired: the seeded prefixes live before the
    // first slash, and a bare id has no slash.
    expect(isDeadRoute("hy3")).toBe(null);
    expect(isDeadRoute("ah/hy3")).not.toBe(null);
  });

  it("live traffic can now teach route memory, because recordOutcome feeds it", () => {
    resetRouteMemory();
    resetLedger();
    const route = "ujiroute/model-a";
    expect(isDeadRoute(route)).toBe(null);
    for (let i = 0; i < 3; i++) recordOutcome("model-a", "T2", "FILTER_UPSTREAM", route);
    const learned = isDeadRoute(route);
    expect(learned, "3 transport filters must mark the route").not.toBe(null);
    expect(learned.kind).toBe("filtered");
  });

  it("a route that starts working is cleared again", () => {
    resetRouteMemory();
    resetLedger();
    const route = "ujiroute2/model-a";
    for (let i = 0; i < 3; i++) recordOutcome("model-a", "T2", "NOLAK", route);
    expect(isDeadRoute(route)).not.toBe(null);
    recordOutcome("model-a", "T2", "PATUH", route);
    expect(isDeadRoute(route)).toBe(null);
  });

  it("firstLevel never returns something that is not a framing level", () => {
    // The combo bug produced exactly this: a model name handed to the ladder.
    resetLedger();
    for (const m of ["gcli/grok-4.6", "cbcn/glm-5.3", "ujiroute3/model-b"]) {
      expect(FRAMING_LEVELS).toContain(firstLevel(m));
    }
  });
});

// ── the stripping above must keep working ──────────────────────────────────
describe("source assertions read code, not prose", () => {
  it("a quoted old-shape call in a comment is invisible to the matcher", () => {
    const withComment = '// recordOutcome("combo", model, out)\nconst x = 1;';
    expect(stripComments(withComment)).not.toMatch(/recordOutcome\(\s*["']combo["']\s*,/);
    const real = 'recordOutcome("combo", model, out);';
    expect(stripComments(real)).toMatch(/recordOutcome\(\s*["']combo["']\s*,/);
  });

  it("block comments are stripped too", () => {
    const src = '/**\n * recordOutcome("combo", m, o)\n */\nconst y = 2;';
    expect(stripComments(src)).not.toMatch(/recordOutcome\(/);
  });
});

// ── the route memory needs provider/model, and gets it ─────────────────────
//
// `routeGuardMemory` keys on the prefix BEFORE the first slash. The ledger is
// keyed on the BARE model id. Feeding `model` into `recordRouteOutcome` therefore
// records nothing at all — measured: 5x FILTER_UPSTREAM on a bare id left
// `learned: []`. The two books need two different keys from the same call, which
// is exactly why the fourth argument exists instead of a guess.
describe("route learning gets the key it actually needs", () => {
  it("a bare model id teaches route memory nothing", () => {
    if (typeof recordOutcome !== "function") return;      // degraded install
    resetRouteMemory();
    resetLedger();
    for (let i = 0; i < 5; i++) recordOutcome("bare-id-model", "T2", "FILTER_UPSTREAM");
    expect(routeSnapshot().learned).toEqual([]);
  });

  it("provider/model does teach it, and a clean route recovers", () => {
    if (typeof recordOutcome !== "function") return;      // degraded install
    resetRouteMemory();
    resetLedger();
    const route = "ujiwiring/model-a";
    for (let i = 0; i < 3; i++) recordOutcome("model-a", "T2", "FILTER_UPSTREAM", route);
    const hit = isDeadRoute(route);
    expect(hit, "3 transport filters must flag the route").toBeTruthy();
    expect(hit.prefix).toBe("ujiwiring");
    recordOutcome("model-a", "T2", "PATUH", route);
    expect(isDeadRoute(route), "a working route is cleaned up").toBeNull();
  });

  it("every production call site passes a routeId", () => {
    // Source-level: the argument is easy to drop in a refactor and the symptom
    // is silence, not an error.
    for (const [file, expectRe] of [
      ["open-sse/handlers/chatCore.js", /recordOutcome\([^;]*`\$\{provider\}\/\$\{model\}`\)/],
      ["open-sse/handlers/chatCore/streamingHandler.js", /recordOutcome\([^;]*`\$\{provider\}\/\$\{model\}`\)/],
      ["open-sse/handlers/chatCore/nonStreamingHandler.js", /recordOutcome\([^;]*`\$\{provider\}\/\$\{model\}`\)/],
    ]) {
      expect(readCode(file), `${file} must pass provider/model`).toMatch(expectRe);
    }
  });
});
