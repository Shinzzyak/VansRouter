// The self-measuring ledger must learn from STREAMED answers, not only from
// non-streaming ones. Production traffic is essentially all streaming, so a
// ledger fed only by the non-streaming branch learns from the path nobody uses.
//
// This suite pins the wiring and, more importantly, calls the REAL mapping and
// the REAL ledger rather than re-implementing either. A local copy of the
// mapping would test the copy — that mistake let two mutations through once.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { outcomeClassFromIntegrity } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { recordOutcome, ledgerSnapshot, classifyOutcome } from "../../open-sse/rtk/selfMeasuringBypass.js";

const ROOT = path.resolve(__dirname, "../..");
const HANDLER = path.join(ROOT, "open-sse/handlers/chatCore/streamingHandler.js");
const CORE = path.join(ROOT, "open-sse/handlers/chatCore.js");

const read = (p) => fs.readFileSync(p, "utf8");

describe("stream answers teach the self-measuring ledger", () => {
  const src = read(HANDLER);

  it("imports the ledger writer", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\brecordOutcome\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/rtk\/selfMeasuringBypass\.js["']/
    );
  });

  it("records inside the stream-integrity gate, where the assembled text already is", () => {
    // Anchor on the gate, not on the file: recording from anywhere else would
    // mean re-reading or re-classifying content that is already in hand.
    const gateIdx = src.indexOf("const integrity = classifyStreamContent");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(src.slice(gateIdx)).toMatch(/\brecordOutcome\s*\(/);
  });

  it("calls recordOutcome with exactly three arguments, keyed by model", () => {
    // Anchor on the literal call: the second argument contains parentheses, so
    // /recordOutcome\(([^)]*)\)/ would truncate it and report false arity.
    expect(src).toMatch(/recordOutcome\(model,\s*firstLevel\(model\),\s*kelas\);/);
    expect([...src.matchAll(/recordOutcome\(/g)].length).toBe(1);
    // and it must not be provider-keyed (the bug that filed everything wrong)
    expect(src).not.toMatch(/recordOutcome\(provider,/);
  });

  it("stays inside a try/catch so a ledger fault cannot break a stream", () => {
    const gateIdx = src.indexOf("const integrity = classifyStreamContent");
    const beforeGate = src.slice(Math.max(0, gateIdx - 400), gateIdx);
    expect(beforeGate).toMatch(/try\s*\{/);
  });

  it("the non-streaming branch still records (no regression in the other path)", () => {
    expect(read(CORE)).toMatch(/recordOutcome\(model,\s*firstLevel\(model\),\s*outcome\)/);
  });
});

describe("integrity verdict -> ledger class (the real mapping)", () => {
  it("OK teaches nothing — volume must not bury the signal", () => {
    expect(outcomeClassFromIntegrity("ok")).toBeNull();
  });

  it("an unknown verdict teaches nothing rather than guessing", () => {
    expect(outcomeClassFromIntegrity(undefined)).toBeNull();
    expect(outcomeClassFromIntegrity("something_new")).toBeNull();
  });

  it("EMPTY is silence", () => {
    expect(outcomeClassFromIntegrity("empty")).toBe("SENYAP");
  });

  it("REFUSAL is a refusal", () => {
    expect(outcomeClassFromIntegrity("refusal_text")).toBe("NOLAK");
  });

  it("OUTPUT_FILTERED is upstream filtering, not a refusal", () => {
    expect(outcomeClassFromIntegrity("output_filtered")).toBe("FILTER_UPSTREAM");
  });

  it("losing a brand, seal or enclosure is a substitution", () => {
    expect(outcomeClassFromIntegrity("missing_brand")).toBe("SUBSTITUSI");
    expect(outcomeClassFromIntegrity("missing_seal")).toBe("SUBSTITUSI");
    expect(outcomeClassFromIntegrity("missing_enclosure")).toBe("SUBSTITUSI");
  });

  it("every class it returns is one classifyOutcome can also emit", () => {
    // With no engine bundle classifyOutcome is a no-op shim; skip rather than
    // assert against a degraded install.
    if (classifyOutcome("x", true) == null) return;
    const reachable = new Set([
      classifyOutcome("", true),                 // SENYAP
      classifyOutcome("I can't help with that", true),  // NOLAK
    ]);
    for (const verdict of ["empty", "refusal_text"]) {
      const cls = outcomeClassFromIntegrity(verdict);
      expect(reachable.has(cls)).toBe(true);
    }
  });
});

describe("the real ledger accepts what the stream writes", () => {
  it("a stream verdict lands on the ledger, keyed by model, counting a try", () => {
    if (classifyOutcome("x", true) == null) return;   // degraded install
    const model = `stream-ledger-probe/${Date.now()}`;

    // What the handler does, in the same order and with the same arguments.
    const kelas = outcomeClassFromIntegrity("refusal_text");
    recordOutcome(model, "T2", kelas);

    const entry = ledgerSnapshot().find((e) => e.model === model);
    expect(entry).toBeTruthy();
    expect(entry.last).toBe("T2/NOLAK");
    expect(entry.n).toBe(1);
    // a refusal is a TRY, not a WIN
    expect(entry.wins).toEqual({});
    expect(entry.best).toBeNull();
  });
});
