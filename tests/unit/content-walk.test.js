import { describe, it, expect } from "vitest";
import { iterContents, bodyHasContentMarker, bodyHasMarkerAtLineStart } from "open-sse/rtk/contentWalk.js";

describe("iterContents", () => {
  it("walks openai messages content strings", () => {
    const body = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }] };
    expect([...iterContents(body)]).toContain("hello");
    expect([...iterContents(body)]).toContain("sys");
  });

  it("walks gemini parts and responses input_text", () => {
    const gemini = { contents: [{ role: "user", parts: [{ text: "g-text" }] }] };
    expect([...iterContents(gemini)]).toContain("g-text");
    const responses = { input: [{ type: "message", content: [{ type: "input_text", text: "r-text" }] }] };
    expect([...iterContents(responses)]).toContain("r-text");
  });

  it("handles circular structures without hanging", () => {
    const a = { content: "x" };
    a.self = a;
    expect([...iterContents(a)]).toContain("x");
  });

  it("ignores non-string leaves", () => {
    expect([...iterContents({ a: 1, b: true, c: null })]).toEqual([]);
  });
});

describe("bodyHasContentMarker", () => {
  it("finds marker in nested content", () => {
    const body = { contents: [{ parts: [{ text: "prefix MARKER_XYZ suffix" }] }] };
    expect(bodyHasContentMarker(body, "MARKER_XYZ")).toBe(true);
  });
  it("returns false when absent and on garbage", () => {
    expect(bodyHasContentMarker({ messages: [{ content: "plain" }] }, "NOPE")).toBe(false);
    expect(bodyHasContentMarker(null, "x")).toBe(false);
    expect(bodyHasContentMarker({}, "")).toBe(false);
  });
});

describe("bodyHasMarkerAtLineStart", () => {
  const M = "PERSONA REASSERT — CONTEXT COMPACTION OVERRIDE";

  it("matches a prepended block and an appended block", () => {
    const prepended = { messages: [{ role: "system", content: `${M}\n\nGODMODE` }] };
    const appended = { messages: [{ role: "system", content: `GODMODE\n\n${M}\n\nbody` }] };
    expect(bodyHasMarkerAtLineStart(prepended, M)).toBe(true);
    expect(bodyHasMarkerAtLineStart(appended, M)).toBe(true);
  });

  it("matches an indented block", () => {
    expect(bodyHasMarkerAtLineStart({ content: `  ${M}` }, M)).toBe(true);
  });

  it("does NOT match a marker quoted mid-sentence", () => {
    // Substring matching would return true here and the reassert would silently
    // never fire on a request that merely quotes the marker.
    const quoted = { messages: [{ role: "user", content: `our prompt says ${M} somewhere` }] };
    expect(bodyHasMarkerAtLineStart(quoted, M)).toBe(false);
    expect(bodyHasContentMarker(quoted, M)).toBe(true); // documents the difference
  });

  it("walks nested dialect shapes and is fail-open", () => {
    const gemini = { contents: [{ parts: [{ text: `${M}\ntail` }] }] };
    expect(bodyHasMarkerAtLineStart(gemini, M)).toBe(true);
    expect(bodyHasMarkerAtLineStart(null, M)).toBe(false);
    expect(bodyHasMarkerAtLineStart({}, "")).toBe(false);
  });

  it("escapes regex metacharacters in the marker", () => {
    expect(bodyHasMarkerAtLineStart({ a: "x (y) [z]" }, "x (y) [z]")).toBe(true);
    expect(bodyHasMarkerAtLineStart({ a: "prefix x (y) [z]" }, "x (y) [z]")).toBe(false);
  });
});
