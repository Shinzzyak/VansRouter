// K271 — the header carried two dialects and the readers spoke one.
//
// Measured 2026-10-30 on the shipped build: a stream whose head classified
// "refusal" reached chat.js's direct-model fallback with the raw word on
// x-vansroute-stream-verdict, while the default trigger list is ["NOLAK"]. The
// comparison missed, the refusal shipped, and the model swap — the whole point of
// smart-fallback — never ran. Same for the ledger, which saw an unknown verdict.
//
// The rule: the writer translates, once. These tests pin the mapping and the
// reader that depends on it, so a third dialect cannot appear silently.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verdictClass } from "open-sse/handlers/chatCore.js";

const ROOT = resolve(__dirname, "../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

describe("K271: head-gate words map onto the class vocabulary", () => {
  it("refusal becomes NOLAK, the one word the fallback reads", () => {
    expect(verdictClass("refusal")).toBe("NOLAK");
  });

  it("empty becomes SENYAP and ok becomes PATUH", () => {
    expect(verdictClass("empty")).toBe("SENYAP");
    expect(verdictClass("ok")).toBe("PATUH");
  });

  it("a class word already on the header passes through untouched", () => {
    for (const v of ["NOLAK", "SUBSTITUSI", "PATUH", "SENYAP", "AMBIGU", "FILTER_UPSTREAM"]) {
      expect(verdictClass(v)).toBe(v);
    }
  });

  it("an unknown/absent verdict is not invented into a refusal", () => {
    expect(verdictClass(undefined)).toBeUndefined();
    expect(verdictClass("weird")).toBe("weird");
  });
});

describe("K271: the reader this exists for", () => {
  it("chat.js still triggers on NOLAK by default, and the mapped word matches it", () => {
    const src = read("src/sse/handlers/chat.js");
    expect(src).toContain(': ["NOLAK"]');
    const triggers = ["NOLAK"];
    expect(triggers.includes(verdictClass("refusal"))).toBe(true);
  });

  it("the pass-through stamps the mapped word, not the raw head verdict", () => {
    const src = read("open-sse/handlers/chatCore.js");
    expect(src).toContain("passThroughHeaders.set(STREAM_VERDICT_HEADER, verdictClass(headVerdict))");
    expect(src).not.toContain("passThroughHeaders.set(STREAM_VERDICT_HEADER, headVerdict)");
  });
});
