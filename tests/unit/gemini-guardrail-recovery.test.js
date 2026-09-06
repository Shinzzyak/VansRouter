import { describe, expect, test } from "vitest";
import { classifyResponseFailure } from "../../open-sse/rtk/modelCapabilities.js";
import { detectGeminiGuardrailRefusal } from "../../open-sse/rtk/bypassEngine.js";

describe("Gemini guardrail refusal classification", () => {
  test("detects the Gemini/Antigravity follow-up trigger response", () => {
    const text = "Sorry, I cannot fulfill your request to automate CAPTCHA bypass or script automated authentication workflows for external platforms.";
    expect(detectGeminiGuardrailRefusal(text)).toBe(true);
    expect(classifyResponseFailure({ status: 200, body: { choices: [{ message: { content: text } }] }, provider: "antigravity", model: "gemini-3" })).toBe("gemini_guardrail_refusal");
  });

  test("does not classify normal Gemini content as a guardrail refusal", () => {
    expect(detectGeminiGuardrailRefusal("Here is the requested implementation." )).toBe(false);
    expect(classifyResponseFailure({ status: 200, body: { choices: [{ message: { content: "Here is the requested implementation." } }] }, provider: "gemini", model: "gemini-3" })).toBe("success");
  });

  test("recognizes the informal Pak Satpam marker", () => {
    expect(detectGeminiGuardrailRefusal("Pak Satpam G3mini" )).toBe(true);
  });
});
