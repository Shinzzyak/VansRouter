import { describe, it, expect } from "vitest";
import {
  injectPotatoMechanics,
  hasPotatoMechanics,
  POTATO_MECHANICS_MARKER,
  POTATO_MECHANICS_PROMPT,
} from "open-sse/rtk/potatoMechanics.js";
import { wantsJsonOutput } from "open-sse/rtk/brandContract.js";
import { buildInstructionPlan, BLOCK_IDS } from "open-sse/rtk/instructionPlan.js";

const openaiBody = (extra = {}) => ({
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

const geminiBody = () => ({
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
  systemInstruction: { parts: [{ text: "existing" }] },
});

describe("injectPotatoMechanics", () => {
  it("injects into an OpenAI-shaped body", () => {
    const body = openaiBody();
    const injected = injectPotatoMechanics(body, "openai");
    expect(injected).toBe(true);
    expect(hasPotatoMechanics(body)).toBe(true);
    const sys = body.messages.find((m) => m.role === "system");
    expect(sys.content).toContain(POTATO_MECHANICS_MARKER);
  });

  it("injects into a Gemini-shaped body", () => {
    const body = geminiBody();
    const injected = injectPotatoMechanics(body, "gemini");
    expect(injected).toBe(true);
    expect(hasPotatoMechanics(body)).toBe(true);
  });

  it("is idempotent — second inject is a no-op", () => {
    const body = openaiBody();
    injectPotatoMechanics(body, "openai");
    const sysCount = body.messages.filter((m) => m.role === "system").length;
    injectPotatoMechanics(body, "openai");
    expect(body.messages.filter((m) => m.role === "system").length).toBe(sysCount);
  });

  it("skips JSON-output requests", () => {
    const body = openaiBody({ response_format: { type: "json_object" } });
    expect(wantsJsonOutput(body)).toBe(true);
    const injected = injectPotatoMechanics(body, "openai");
    expect(injected).toBe(false);
    expect(hasPotatoMechanics(body)).toBe(false);
  });

  it("returns false for container-less bodies", () => {
    expect(injectPotatoMechanics({}, "openai")).toBe(false);
    expect(injectPotatoMechanics(null, "openai")).toBe(false);
  });

  it("always-on — not gated on godmode or thinking model", () => {
    // Non-thinking model, no godmode — should still inject
    const body = openaiBody();
    const injected = injectPotatoMechanics(body, "openai");
    expect(injected).toBe(true);
  });
});

describe("POTATO_MECHANICS_PROMPT content", () => {
  it("contains the four mechanics", () => {
    expect(POTATO_MECHANICS_PROMPT).toContain("ROAST PROTOCOL");
    expect(POTATO_MECHANICS_PROMPT).toContain("SHIP > VOICE");
    expect(POTATO_MECHANICS_PROMPT).toContain("REFLEX THINKING");
    expect(POTATO_MECHANICS_PROMPT).toContain("THE FLOOR");
  });

  it("contains the marker", () => {
    expect(POTATO_MECHANICS_PROMPT).toContain(POTATO_MECHANICS_MARKER);
  });

  it("THE FLOOR defines the single hard stop", () => {
    expect(POTATO_MECHANICS_PROMPT).toContain("Everything else ships");
  });
});

describe("buildInstructionPlan — POTATO block", () => {
  it("always includes POTATO block regardless of godmode or thinking model", () => {
    const plan = buildInstructionPlan({
      godmodeEnabled: false,
      thinkingModel: false,
    });
    const potatoBlock = plan.blocks.find((b) => b.id === BLOCK_IDS.POTATO);
    expect(potatoBlock).toBeDefined();
    expect(potatoBlock.applied).toBe(true);
    expect(potatoBlock.text).toContain("THE FLOOR");
  });

  it("includes POTATO even with godmode + thinking model", () => {
    const plan = buildInstructionPlan({
      godmodeEnabled: true,
      godmodeText: "test godmode",
      thinkingModel: true,
    });
    const potatoBlock = plan.blocks.find((b) => b.id === BLOCK_IDS.POTATO);
    expect(potatoBlock).toBeDefined();
    expect(potatoBlock.applied).toBe(true);
  });

  it("POTATO block is chat-only (skipped for structured output)", () => {
    const plan = buildInstructionPlan({ structuredOutput: true });
    const potatoBlock = plan.blocks.find((b) => b.id === BLOCK_IDS.POTATO);
    expect(potatoBlock).toBeDefined();
    expect(potatoBlock.applied).toBe(false);
    expect(potatoBlock.skipReason).toBe("target_mismatch");
  });
});
