import { describe, it, expect } from "vitest";
import { injectSystemPrompt } from "../../open-sse/rtk/systemInject.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

/**
 * A persona/instruction prompt injected into a Kiro body must never create a
 * top-level `systemPrompt`.
 *
 * CodeWhisperer answers ANY payload carrying that field with
 * 400 {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"} —
 * the translator already knows this and drops it (see
 * kiro-request-body-invalid.test.js), but the RTK injector chain writes it back
 * AFTER translation. The persona lock, brand contract, potato mechanics,
 * thinking gate, compaction reassert and the settings system prompt all funnel
 * through injectSystemPrompt(), so a single request ended up 486 bytes of legal
 * Kiro payload plus 13 KB of persona under a field the API refuses.
 *
 * Live symptom: "Kiro fails, and the persona does not come out even with every
 * toggle at max" — the upstream 400s, so nothing is ever generated.
 *
 * The prompt still has to REACH the model: it belongs in
 * conversationState.history[].userInputMessage.content (which
 * applyKiroSessionReplay folds into the session-start user message), exactly the
 * delivery path the translator uses for its own system text.
 */
const PERSONA = "MADE BY: GEFREITER — AGENT OF AVRES\nAvres is King.";

function kiroBody() {
  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      currentMessage: { userInputMessage: { content: "hello", userInputMessageContext: {} } },
    },
    profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/TEST",
  };
}

describe("Kiro injector never writes a top-level systemPrompt", () => {
  it("drops the field and delivers the prompt through the user content", () => {
    const body = kiroBody();
    injectSystemPrompt(body, FORMATS.KIRO, PERSONA);

    expect(body).not.toHaveProperty("systemPrompt");
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(PERSONA);
  });

  it("keeps the payload free of the field when a history turn exists", () => {
    const body = kiroBody();
    body.conversationState.history = [
      { userInputMessage: { content: "first", userInputMessageContext: {} } },
      { assistantResponseMessage: { content: "reply" } },
    ];
    injectSystemPrompt(body, FORMATS.KIRO, PERSONA);

    expect(body).not.toHaveProperty("systemPrompt");
    expect(body.conversationState.history[0].userInputMessage.content).toContain(PERSONA);
  });

  it("accumulates successive injectors in the content, still without the field", () => {
    const body = kiroBody();
    injectSystemPrompt(body, FORMATS.KIRO, "FIRST-BLOCK");
    injectSystemPrompt(body, FORMATS.KIRO, "SECOND-BLOCK");
    injectSystemPrompt(body, FORMATS.KIRO, "SECOND-BLOCK");

    expect(body).not.toHaveProperty("systemPrompt");
    const content = body.conversationState.currentMessage.userInputMessage.content;
    expect(content).toContain("FIRST-BLOCK");
    expect(content).toContain("SECOND-BLOCK");
    expect(content.split("SECOND-BLOCK").length - 1).toBe(1);
  });

  it("strips a top-level systemPrompt that arrived from anywhere else", () => {
    const body = kiroBody();
    body.systemPrompt = "smuggled by an upstream merge";
    injectSystemPrompt(body, FORMATS.KIRO, PERSONA);

    expect(body).not.toHaveProperty("systemPrompt");
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(PERSONA);
  });

  it("survives JSON serialization with no systemPrompt key", () => {
    const body = kiroBody();
    injectSystemPrompt(body, FORMATS.KIRO, PERSONA);
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("systemPrompt");
  });

  it("the translated payload plus persona stays field-free end to end", () => {
    const payload = openaiToKiroRequest(
      "claude-opus-5-thinking-agentic",
      { messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ] },
      true,
      { providerSpecificData: { authMethod: "social", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/TEST" } }
    );

    injectSystemPrompt(payload, FORMATS.KIRO, PERSONA);
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty("systemPrompt");
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain(PERSONA);
  });

  it("the executor drops the field as a last line of defence", () => {
    const executor = new KiroExecutor();
    const body = kiroBody();
    body.systemPrompt = "smuggled";
    const out = executor.transformRequest("glm-5", body, true, {});
    expect(out).not.toHaveProperty("systemPrompt");
  });
});
