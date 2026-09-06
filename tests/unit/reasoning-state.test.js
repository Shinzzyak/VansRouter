import { describe, it, expect } from "vitest";
import { reasoningStatePolicy, stripReasoningState } from "open-sse/rtk/reasoningState.js";

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
