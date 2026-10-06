import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { emptyReasonFor } from "../../open-sse/handlers/chatCore/emptyReason.js";

// K42: a reply can arrive as HTTP 200 with no visible text. Two very different
// things produce that — a legitimate tool-call turn, and a reasoning budget that
// ate the whole cap — and before this predicate existed the ledger could not tell
// them apart on the non-streaming path. The streaming path already had it
// (`empty_reason`); this test locks both readers onto ONE definition.
describe("emptyReasonFor — empty_reply disambiguation (K42)", () => {
  it("null when there IS visible text", () => {
    expect(emptyReasonFor({ content: "hello", sawToolCalls: false, finishReason: "stop" })).toBe(null);
  });

  it("tool_calls when the turn legitimately carried tool calls", () => {
    expect(emptyReasonFor({ content: "", sawToolCalls: true, finishReason: "tool_calls" })).toBe("tool_calls");
  });

  it("no_text:<finishReason> when a cap was exhausted with nothing visible", () => {
    expect(emptyReasonFor({ content: "", sawToolCalls: false, finishReason: "length" })).toBe("no_text:length");
  });

  it("no_text when the provider gave no finish reason at all", () => {
    expect(emptyReasonFor({ content: "", sawToolCalls: false, finishReason: null })).toBe("no_text");
  });

  it("INVARIANT: tool-call turn wins over a missing finish reason", () => {
    expect(emptyReasonFor({ content: "", sawToolCalls: true, finishReason: null })).toBe("tool_calls");
  });

  // The 2026-09-22 incident (ring and ledger drifted) happened because the same
  // expression was written twice. Both handlers must import the one helper.
  it("PARITY: streaming AND non-streaming handlers both read the shared helper", () => {
    const base = "/home/ubuntu/VansRouter/open-sse/handlers/chatCore/";
    for (const f of ["streamingHandler.js", "nonStreamingHandler.js"]) {
      const src = readFileSync(base + f, "utf8");
      expect(src, `${f} must call emptyReasonFor`).toMatch(/emptyReasonFor\(/);
      expect(src, `${f} must not re-implement the predicate`).not.toMatch(/toolCallOnly\s*=\s*sawToolCalls/);
    }
  });

  it("PARITY: the non-streaming response block exposes empty_reason", () => {
    const src = readFileSync("/home/ubuntu/VansRouter/open-sse/handlers/chatCore/nonStreamingHandler.js", "utf8");
    expect(src).toMatch(/empty_reason:/);
  });
});
