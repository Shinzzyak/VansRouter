import { describe, it, expect } from "vitest";
import { parseLenientJson } from "open-sse/utils/lenientJson.js";

const CHAT = JSON.stringify({
  id: "chatcmpl-abc",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
});

describe("parseLenientJson", () => {
  it("passes clean JSON through", () => {
    expect(parseLenientJson(CHAT)).toMatchObject({ id: "chatcmpl-abc" });
  });

  it("recovers concatenated objects (zrouter/xgate live shape)", () => {
    const raw = CHAT + JSON.stringify({ id: "second" });
    const out = parseLenientJson(raw);
    expect(out).toMatchObject({ id: "chatcmpl-abc" });
    expect(out.choices[0].message.content).toBe("hi");
  });

  it("recovers JSON with trailing HTML garbage", () => {
    const out = parseLenientJson(CHAT + "<html><body>bad gateway</body></html>");
    expect(out).toMatchObject({ id: "chatcmpl-abc" });
  });

  it("recovers JSON with leading whitespace and BOM", () => {
    expect(parseLenientJson("\uFEFF  \n" + CHAT)).toMatchObject({ id: "chatcmpl-abc" });
  });

  it("recovers first object from NDJSON lines", () => {
    const raw = `{"a":1}\n${CHAT}\n{"z":9}`;
    expect(parseLenientJson(raw)).toMatchObject({ a: 1 });
  });

  it("handles braces inside string literals", () => {
    const raw = JSON.stringify({ content: "a { b } c" }) + "TRAILER";
    expect(parseLenientJson(raw)).toMatchObject({ content: "a { b } c" });
  });

  it("returns null for pure HTML, empty, and non-strings", () => {
    expect(parseLenientJson("<html>nope</html>")).toBeNull();
    expect(parseLenientJson("   ")).toBeNull();
    expect(parseLenientJson(null)).toBeNull();
    expect(parseLenientJson(undefined)).toBeNull();
  });
});
