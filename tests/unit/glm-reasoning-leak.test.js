// GLM-5.2 defaults thinking ON when no reasoning intent is sent, which leaks
// reasoning content into the assistant response. We force-disable it.
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("GLM-5.2 reasoning leak prevention", () => {
  it("disables thinking by default when client does not request reasoning", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyThinking("claude", "glm-5.2", body, "glm");
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("keeps thinking enabled when client explicitly requests reasoning", () => {
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" };
    applyThinking("claude", "glm-5.2", body, "glm");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.enable_thinking).toBeUndefined();
  });

  it("respects explicit reasoning off", () => {
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" };
    applyThinking("claude", "glm-5.2", body, "glm");
    expect(body.enable_thinking).toBe(false);
  });

  it("applies to other glm-5.x models", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyThinking("claude", "glm-5.1", body, "glm");
    expect(body.enable_thinking).toBe(false);
  });
});
