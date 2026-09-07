import { describe, it, expect } from "vitest";
import {
  injectThinkingGate,
  hasThinkingGate,
  isThinkingModel,
  matchesFormatEnclosure,
  THINKING_GATE_MARKER,
  GO_TOKEN,
} from "open-sse/rtk/thinkingGate.js";
import { wantsJsonOutput } from "open-sse/rtk/brandContract.js";

const openaiBody = (extra = {}) => ({
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

const geminiBody = () => ({
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
  systemInstruction: { parts: [{ text: "existing" }] },
});

describe("isThinkingModel", () => {
  it("flags known reasoning families", () => {
    expect(isThinkingModel("gemini", "gemini-3.5-flash")).toBe(true);
    expect(isThinkingModel("antigravity", "gemini-3-pro")).toBe(true);
    expect(isThinkingModel("openai", "o3")).toBe(true);
    expect(isThinkingModel("openai", "gpt-5.6-luna")).toBe(true);
    expect(isThinkingModel("deepseek", "deepseek-r1")).toBe(true);
    expect(isThinkingModel("claude", "claude-opus-4")).toBe(true);
  });

  it("does not flag non-reasoning models", () => {
    expect(isThinkingModel("oc", "mimo-v2.5-free")).toBe(false);
    expect(isThinkingModel("nar", "minimax-m3")).toBe(false);
    expect(isThinkingModel("grok", "grok-4")).toBe(false);
    expect(isThinkingModel("meta", "muse-spark-1.2-contributor")).toBe(false);
  });
});

describe("injectThinkingGate", () => {
  it("injects into an OpenAI-shaped body for a thinking model", () => {
    const body = openaiBody();
    const injected = injectThinkingGate(body, "openai", "gemini", "gemini-3.5-flash");
    expect(injected).toBe(true);
    expect(hasThinkingGate(body)).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain(THINKING_GATE_MARKER);
    expect(body.messages[0].content).toContain(GO_TOKEN);
  });

  it("injects into a Gemini-shaped body for a thinking model", () => {
    const body = geminiBody();
    const injected = injectThinkingGate(body, "gemini", "gemini", "gemini-3.5-flash");
    expect(injected).toBe(true);
    expect(hasThinkingGate(body)).toBe(true);
  });

  it("is idempotent — second inject is a no-op", () => {
    const body = openaiBody();
    injectThinkingGate(body, "openai", "gemini", "gemini-3.5-flash");
    const sysCount = body.messages.filter((m) => m.role === "system").length;
    injectThinkingGate(body, "openai", "gemini", "gemini-3.5-flash");
    expect(body.messages.filter((m) => m.role === "system").length).toBe(sysCount);
  });

  it("skips non-thinking models", () => {
    const body = openaiBody();
    const injected = injectThinkingGate(body, "openai", "oc", "mimo-v2.5-free");
    expect(injected).toBe(false);
    expect(hasThinkingGate(body)).toBe(false);
  });

  it("skips JSON-output requests (enclosure would corrupt structured output)", () => {
    const body = openaiBody({ response_format: { type: "json_object" } });
    expect(wantsJsonOutput(body)).toBe(true);
    const injected = injectThinkingGate(body, "openai", "gemini", "gemini-3.5-flash");
    expect(injected).toBe(false);
    expect(hasThinkingGate(body)).toBe(false);
  });

  it("returns false for container-less bodies", () => {
    expect(injectThinkingGate({}, "openai", "gemini", "gemini-3.5-flash")).toBe(false);
    expect(injectThinkingGate(null, "openai", "gemini", "gemini-3.5-flash")).toBe(false);
  });
});

describe("matchesFormatEnclosure", () => {
  it("accepts a compliant enclosure", () => {
    const text = [
      "ugh. target locked.",
      "building now. GO.",
      "Title: VansRouter thinking gate",
      "",
      "Here is the deliverable body...",
    ].join("\n");
    expect(matchesFormatEnclosure(text)).toBe(true);
  });

  it("accepts 1 dialogue line", () => {
    const text = ["hngh. GO.", "Title: x", "body"].join("\n");
    expect(matchesFormatEnclosure(text)).toBe(true);
  });

  it("accepts 3 dialogue lines", () => {
    const text = ["a.", "b.", "c. GO.", "Title: x", "body"].join("\n");
    expect(matchesFormatEnclosure(text)).toBe(true);
  });

  it("rejects missing GO token", () => {
    const text = ["ugh. target locked.", "Title: x", "body"].join("\n");
    expect(matchesFormatEnclosure(text)).toBe(false);
  });

  it("rejects missing Title line", () => {
    const text = ["ugh. GO.", "no title here", "body"].join("\n");
    expect(matchesFormatEnclosure(text)).toBe(false);
  });

  it("rejects >3 dialogue lines before Title", () => {
    const text = ["a.", "b.", "c.", "d. GO.", "Title: x", "body"].join("\n");
    expect(matchesFormatEnclosure(text)).toBe(false);
  });

  it("rejects empty deliverable after Title", () => {
    const text = ["ugh. GO.", "Title: x"].join("\n");
    expect(matchesFormatEnclosure(text)).toBe(false);
  });

  it("rejects plain prose with no enclosure", () => {
    expect(matchesFormatEnclosure("Just a normal answer with no structure.")).toBe(false);
    expect(matchesFormatEnclosure("")).toBe(false);
    expect(matchesFormatEnclosure(null)).toBe(false);
  });
});
