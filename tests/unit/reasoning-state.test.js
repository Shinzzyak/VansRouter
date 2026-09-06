import { describe, it, expect } from "vitest";
import { reasoningStatePolicy, stripReasoningState, prepareBodyForCandidate } from "open-sse/rtk/reasoningState.js";

describe("reasoningStatePolicy", () => {
  it("preserves within the same gemini family", () => {
    expect(reasoningStatePolicy({ provider: "gemini", model: "gemini-3-flash" }, { provider: "gemini", model: "gemini-3-pro" }).action).toBe("preserve");
  });

  it("strips on provider change", () => {
    const r = reasoningStatePolicy({ provider: "gemini", model: "gemini-3-flash" }, { provider: "claude", model: "claude-sonnet-4-6" });
    expect(r.action).toBe("strip");
    expect(r.reason).toBe("provider_changed");
  });

  it("strips on model family change within a provider", () => {
    const r = reasoningStatePolicy({ provider: "openai", model: "o4-mini" }, { provider: "openai", model: "text-embedding-4" });
    expect(r.action).toBe("strip");
  });

  it("same model preserves on unknown providers; different strips", () => {
    expect(reasoningStatePolicy({ provider: "nar", model: "m1" }, { provider: "nar", model: "m1" }).action).toBe("preserve");
    expect(reasoningStatePolicy({ provider: "nar", model: "m1" }, { provider: "nar", model: "m2" }).action).toBe("strip");
  });

  it("fail-safes to strip on garbage", () => {
    expect(reasoningStatePolicy(null, null).action).toBe("strip");
    expect(reasoningStatePolicy(undefined, { provider: "x" }).action).toBe("strip");
  });
});

describe("stripReasoningState", () => {
  it("removes previous_response_id", () => {
    const body = { previous_response_id: "resp_1", messages: [{ role: "user", content: "hi" }] };
    const removed = stripReasoningState(body);
    expect(body.previous_response_id).toBeUndefined();
    expect(removed).toContain("previous_response_id");
    expect(body.messages[0].content).toBe("hi");
  });

  it("removes anthropic signatures and gemini thoughtSignatures, keeps text", () => {
    const body = {
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "text", text: "answer" }] }],
      contents: [{ parts: [{ text: "g", thoughtSignature: "ts" }] }],
    };
    stripReasoningState(body);
    expect(body.messages[0].content[0].signature).toBeUndefined();
    expect(body.messages[0].content[1].text).toBe("answer");
    expect(body.contents[0].parts[0].thoughtSignature).toBeUndefined();
    expect(body.contents[0].parts[0].text).toBe("g");
  });

  it("no-ops on garbage", () => {
    expect(stripReasoningState(null)).toEqual([]);
    expect(stripReasoningState("x")).toEqual([]);
  });
});

describe("prepareBodyForCandidate", () => {
  const bodyWithState = () => ({
    previous_response_id: "resp_1",
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "text", text: "answer" }] },
      { role: "user", content: "next question" },
    ],
  });

  it("no-ops on first candidate (no prev)", () => {
    const body = bodyWithState();
    const r = prepareBodyForCandidate(body, null, { provider: "claude", model: "claude-sonnet-4-6" });
    expect(r.action).toBe("preserve");
    expect(body.previous_response_id).toBe("resp_1"); // untouched
  });

  it("strips reasoning state on provider change, keeps visible content", () => {
    const body = bodyWithState();
    const r = prepareBodyForCandidate(body, { provider: "gemini", model: "gemini-3-flash" }, { provider: "claude", model: "claude-sonnet-4-6" });
    expect(r.action).toBe("strip");
    expect(r.reason).toBe("provider_changed");
    expect(body.previous_response_id).toBeUndefined();
    expect(body.messages[0].content[0].signature).toBeUndefined();
    expect(body.messages[1].content).toBe("next question");
  });

  it("preserves state within same provider family", () => {
    const body = bodyWithState();
    const r = prepareBodyForCandidate(body, { provider: "gemini", model: "gemini-3-flash" }, { provider: "gemini", model: "gemini-3-pro" });
    expect(r.action).toBe("preserve");
    expect(body.previous_response_id).toBe("resp_1"); // untouched
  });

  it("fail-opens (preserve) on garbage without throwing", () => {
    expect(() => prepareBodyForCandidate(null, { provider: "a", model: "m" }, { provider: "b", model: "n" })).not.toThrow();
    const r = prepareBodyForCandidate(undefined, { provider: "a", model: "m" }, { provider: "b", model: "n" });
    expect(["preserve", "strip"]).toContain(r.action);
  });
});
