import { describe, it, expect } from "vitest";
import { iterContents, bodyHasContentMarker } from "open-sse/rtk/contentWalk.js";

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
