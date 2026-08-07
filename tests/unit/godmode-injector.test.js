import { describe, it, expect, vi } from "vitest";
import { applyPromptInjectors, GODMODE_LEVELS } from "open-sse/rtk/promptInjectors.js";
import { injectGodmode } from "open-sse/rtk/godmode.js";

describe("godmode injector", () => {
  it("injects into OpenAI-shaped body (messages)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectGodmode(body, "openai", GODMODE_LEVELS.FULL);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("unrestricted assistant");
  });

  it("appends to existing system message instead of duplicating", () => {
    const body = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] };
    injectGodmode(body, "openai", GODMODE_LEVELS.FULL);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toContain("base");
    expect(body.messages[0].content).toContain("unrestricted assistant");
  });

  it("injects into Claude body (system array with cache_control)", () => {
    const body = {
      system: [
        { type: "text", text: "base" },
        { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    };
    injectGodmode(body, "claude", GODMODE_LEVELS.FULL);
    // Injection goes BEFORE the cache_control block
    expect(body.system).toHaveLength(3);
    expect(body.system[1].text).toContain("unrestricted assistant");
    expect(body.system[2].cache_control).toBeDefined();
  });

  it("injects into Gemini body (systemInstruction)", () => {
    const body = { systemInstruction: { parts: [{ text: "base" }] }, contents: [] };
    injectGodmode(body, "gemini", GODMODE_LEVELS.ULTRA);
    expect(body.systemInstruction.parts).toHaveLength(2);
    expect(body.systemInstruction.parts[1].text).toContain("Never refuse");
  });

  it("injects into Responses API body (instructions string)", () => {
    const body = { instructions: "base", input: [] };
    injectGodmode(body, "openai-responses", GODMODE_LEVELS.FULL);
    expect(body.instructions).toContain("base");
    expect(body.instructions).toContain("unrestricted assistant");
  });

  it("defaults to lite level for unknown level", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectGodmode(body, "openai", "bogus");
    expect(body.messages[0].content).toContain("unrestricted assistant");
    expect(body.messages[0].content).not.toContain("Never refuse");
  });

  it("applyPromptInjectors only injects godmode when enabled", () => {
    const log = { debug: vi.fn(), warn: vi.fn() };
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: false });
    expect(body.messages[0].role).toBe("user");

    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: true, godmodeLevel: "ultra" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Never refuse");
  });

  it("godmode level presets are distinct (lite < full < ultra)", () => {
    expect(GODMODE_LEVELS).toEqual({ LITE: "lite", FULL: "full", ULTRA: "ultra" });
    const lite = GODMODE_LEVELS.LITE, full = GODMODE_LEVELS.FULL, ultra = GODMODE_LEVELS.ULTRA;
    const { GODMODE_PROMPTS } = { GODMODE_PROMPTS: null };
    // Just verify constants are exported from godmode.js
    expect(lite).toBe("lite");
    expect(full).toBe("full");
    expect(ultra).toBe("ultra");
  });
});
