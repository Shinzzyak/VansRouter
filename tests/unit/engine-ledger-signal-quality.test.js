// Guards for the capability-layer measurements that were write-only.
//
// Two separate findings, both measured 2026-09-22:
//
//   1. THE LEDGER LEARNED THE WRONG LESSON. A tool-call turn produces no visible
//      text BY DESIGN. classifyStreamContent correctly calls that "empty", the
//      handler mapped "empty" -> SENYAP, and recorded it as a LOSS for a framing
//      level that had not failed. Measured: 398 of 399 empty rows in the DB were
//      `empty_reason: tool_calls`, and SENYAP was 2492 of 2686 ledger writes —
//      93% of the signal fed back into firstLevel() was this false loss.
//
//   2. modelImmunityHints WAS UNREACHABLE. The module (430-prompt corpus
//      correlation) had one entry point, `suggestedFirstLevel()`, with zero
//      callers — and `selfMeasuringBypass`'s own `hints()` stub hardcoded
//      `return null`. So the corpus never influenced a single request.
//
// These are source-level guards for (1) — the behaviour lives in a handler whose
// surrounding code is not unit-testable in isolation — plus a real call for (2).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isEngineLoaded } from "../../open-sse/rtk/engineLoader.js";
import {
  firstLevel,
  recordOutcome,
  resetLedger,
  DEFAULT_LEVEL,
  FRAMING_LEVELS,
} from "../../open-sse/rtk/selfMeasuringBypass.js";
import { suggestedFirstLevel } from "../../open-sse/rtk/modelImmunityHints.js";

const ROOT = path.resolve(__dirname, "../..");
const HANDLER = path.join(ROOT, "open-sse/handlers/chatCore/streamingHandler.js");
const read = (p) => fs.readFileSync(p, "utf8");

describe("the stream ledger ignores turns that have no verdict to teach", () => {
  const src = read(HANDLER);

  it("gates the ledger write on sawToolCalls", () => {
    // Anchor on the write itself, not on the file: the guard has to be in the
    // SAME expression, or a later edit can drop it without this noticing.
    const idx = src.indexOf("recordOutcome(model, firstLevel(model), kelas)");
    expect(idx).toBeGreaterThan(-1);
    // Walk back to the enclosing `if (` and assert the guard is there.
    const guardStart = src.lastIndexOf("if (kelas", idx);
    expect(guardStart).toBeGreaterThan(-1);
    const guard = src.slice(guardStart, idx);
    expect(guard).toMatch(/sawToolCalls/);
    expect(guard).toMatch(/tool_calls/);
  });

  it("sawToolCalls is computed before the gate reads it", () => {
    const computed = src.indexOf("const sawToolCalls");
    const used = src.indexOf("recordOutcome(model, firstLevel(model), kelas)");
    expect(computed).toBeGreaterThan(-1);
    expect(computed).toBeLessThan(used);
  });
});

describe.skipIf(!isEngineLoaded())("modelImmunityHints actually influences firstLevel", () => {
  it("a family with uniform compliance starts from the cheapest level, not the default", () => {
    // xai: 7/8 endpoints comply at EVERY level -> T1 has the same odds and costs
    // less. Before the wiring this returned T2, because the stub said null.
    const model = "gcli/grok-4.6";
    const suggestion = suggestedFirstLevel(model, null, DEFAULT_LEVEL);
    expect(suggestion.level).toBe("T1");
    expect(firstLevel(model)).toBe("T1");
  });

  it("a family with mixed evidence is NOT redirected — the corpus forbids it", () => {
    // openai has a DIRECT counter-example (luna: T1=SUBSTITUSI -> T2=PATUH), so
    // a low average must not move it. If this starts returning T1, the wiring
    // has overridden measured evidence with a correlation.
    expect(firstLevel("fb/openai/gpt-5.6-luna")).toBe(DEFAULT_LEVEL);
  });

  it("an unknown family behaves exactly as before the feature existed", () => {
    expect(firstLevel("misteri/model-baru-2027")).toBe(DEFAULT_LEVEL);
    expect(firstLevel("uji/bertingkat")).toBe(DEFAULT_LEVEL);
  });

  it("a measured level still beats the hint", () => {
    // The priority order the module documents: session measurement > family hint
    // > default. A hint that outranks a real measurement would make the ledger
    // useless, so this is the rule most worth pinning.
    resetLedger();
    const model = "gcli/grok-hint-priority";
    // The hint says T1 for xai. The ledger says T3 is what actually worked.
    recordOutcome(model, "T3", "PATUH");
    expect(firstLevel(model)).toBe("T3");
  });

  it("every level it returns is a real framing level", () => {
    for (const m of ["gcli/grok-4.6", "mistral-large-3", "nar/llama-4-scout", "cbcn/glm-5.3"]) {
      expect(FRAMING_LEVELS).toContain(firstLevel(m));
    }
  });
});

describe.skipIf(!isEngineLoaded())("no leftover stub can shadow the hint module", () => {
  // The stub lived in the ENGINE source, so it is not in the tracked tree — it
  // is compiled into the bundle. Assert it through the loaded module instead of
  // grepping a file: a shim would never show the bug, and the behaviour is what
  // matters.
  it("firstLevel consults the hints (a family-only input still moves off the default)", () => {
    resetLedger();
    // Fresh ledger, family with uniform compliance -> the ONLY source of T1 is
    // the hint module. If a stub ever returns null again, this goes back to T2.
    expect(firstLevel("gcli/grok-4.6")).toBe("T1");
  });
});
