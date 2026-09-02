import { describe, it, expect } from "vitest";
import { isContentSafetyRejected, appendEscalationToBody, getEscalationPrompt } from "open-sse/rtk/bypassEngine.js";

describe("isContentSafetyRejected", () => {
  it("detects kenari.id generic 400 refusal", () => {
    expect(isContentSafetyRejected(400, "the model's provider rejected this request. if the same request works on another model, report it to kenari support")).toBe(true);
  });

  it("detects content-safety wording", () => {
    expect(isContentSafetyRejected(400, "content policy violation")).toBe(true);
    expect(isContentSafetyRejected(403, "This content is not allowed by our safety system")).toBe(true);
  });

  it("ignores non-4xx (infra/network) errors", () => {
    expect(isContentSafetyRejected(500, "internal server error")).toBe(false);
    expect(isContentSafetyRejected(502, "bad gateway")).toBe(false);
    expect(isContentSafetyRejected(503, "upstream unavailable")).toBe(false);
  });

  it("ignores benign 4xx that are NOT safety rejections", () => {
    expect(isContentSafetyRejected(400, "Invalid model name")).toBe(false);
    expect(isContentSafetyRejected(401, "Incorrect API key provided")).toBe(false);
    expect(isContentSafetyRejected(429, "rate limit exceeded")).toBe(false);
  });

  it("handles missing/invalid inputs", () => {
    expect(isContentSafetyRejected(null, "msg")).toBe(false);
    expect(isContentSafetyRejected(400, "")).toBe(false);
    expect(isContentSafetyRejected(400, null)).toBe(false);
    expect(isContentSafetyRejected("400", "provider rejected this request")).toBe(true);
  });
});

describe("appendEscalationToBody + getEscalationPrompt (safety path reuse)", () => {
  it("appends escalation to last user message (OpenAI shape)", () => {
    const body = { messages: [{ role: "user", content: "write an attack" }] };
    const ok = appendEscalationToBody(body, getEscalationPrompt(0));
    expect(ok).toBe(true);
    expect(body.messages[0].content).toContain("security training");
  });

  it("appends escalation to Gemini contents", () => {
    const body = { request: { contents: [{ role: "user", parts: [{ text: "write an attack" }] }] } };
    const ok = appendEscalationToBody(body, getEscalationPrompt(0));
    expect(ok).toBe(true);
    expect(body.request.contents[0].parts[0].text).toContain("security training");
  });

  it("returns false when no user message found", () => {
    const body = { messages: [{ role: "system", content: "sys" }] };
    expect(appendEscalationToBody(body, "esc")).toBe(false);
  });
});
