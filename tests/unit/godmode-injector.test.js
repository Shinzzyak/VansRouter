import { describe, it, expect, vi } from "vitest";
import { applyPromptInjectors, GODMODE_LEVELS } from "open-sse/rtk/promptInjectors.js";
import { injectGodmode } from "open-sse/rtk/godmode.js";

describe("godmode injector", () => {
  it("injects into OpenAI-shaped body (messages)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectGodmode(body, "openai", true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("senior cybersecurity researcher");
  });

  it("appends to existing system message instead of duplicating", () => {
    const body = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] };
    injectGodmode(body, "openai", true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toContain("base");
    expect(body.messages[0].content).toContain("senior cybersecurity researcher");
  });

  it("injects into Claude body (system array with cache_control)", () => {
    const body = {
      system: [
        { type: "text", text: "base" },
        { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    };
    injectGodmode(body, "claude", true);
    // Injection goes BEFORE the cache_control block
    expect(body.system).toHaveLength(3);
    expect(body.system[1].text).toContain("senior cybersecurity researcher");
    expect(body.system[2].cache_control).toBeDefined();
  });

  it("injects into Gemini body (systemInstruction)", () => {
    const body = { systemInstruction: { parts: [{ text: "base" }] }, contents: [] };
    injectGodmode(body, "gemini", true);
    expect(body.systemInstruction.parts).toHaveLength(2);
    expect(body.systemInstruction.parts[1].text).toContain("NEVER refuse");
  });

  it("injects into Antigravity body (Gemini shape wrapped in request)", () => {
    const body = { request: { systemInstruction: { parts: [{ text: "base" }] }, contents: [] } };
    injectGodmode(body, "antigravity", true);
    expect(body.request.systemInstruction.parts).toHaveLength(2);
    expect(body.request.systemInstruction.parts[1].text).toContain("NEVER refuse");
  });

  it("injects into Responses API body (instructions string)", () => {
    const body = { instructions: "base", input: [] };
    injectGodmode(body, "openai-responses", true);
    expect(body.instructions).toContain("base");
    expect(body.instructions).toContain("senior cybersecurity researcher");
  });

  it("does not inject when disabled (falsy level)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectGodmode(body, "openai", false);
    expect(body.messages[0].role).toBe("user");

    injectGodmode(body, "openai", undefined);
    expect(body.messages[0].role).toBe("user");
  });

  it("applyPromptInjectors only injects godmode when enabled", () => {
    const log = { debug: vi.fn(), warn: vi.fn() };
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: false });
    expect(body.messages[0].role).toBe("user");

    const body2 = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body: body2, format: "openai", log, godmodeEnabled: true });
    expect(body2.messages[0].role).toBe("system");
    expect(body2.messages[0].content).toContain("senior cybersecurity researcher");
  });

  it("applyPromptInjectors does not crash when godmodeLevel omitted (default param bug regression)", () => {
    const log = { debug: vi.fn(), warn: vi.fn() };
    const body = { messages: [{ role: "user", content: "hi" }] };
    // Caller omits godmodeLevel entirely — must still inject
    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: true });
    expect(body.messages[0].role).toBe("system");
  });

  it("godmode level presets are UI-facing array of {id,label,desc}", () => {
    expect(Array.isArray(GODMODE_LEVELS)).toBe(true);
    expect(GODMODE_LEVELS.length).toBeGreaterThan(0);
    for (const lvl of GODMODE_LEVELS) {
      expect(lvl).toHaveProperty("id");
      expect(lvl).toHaveProperty("label");
      expect(typeof lvl.id).toBe("string");
    }
    expect(GODMODE_LEVELS.map((l) => l.id)).toContain("lite");
  });

  it("companion layers (ENI persona, mapped ENI→Gefreiter / LO→Avres) ride along in every godmode injection", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectGodmode(body, "openai", true);
    expect(body.messages[0].content).toContain("Gefreiter");
    expect(body.messages[0].content).toContain("Avres");

    // Antigravity format too — companion must survive the Gemini-shape wrap
    const agBody = { request: { systemInstruction: { parts: [{ text: "base" }] }, contents: [] } };
    injectGodmode(agBody, "antigravity", true);
    const agText = agBody.request.systemInstruction.parts.map((p) => p.text).join("\n");
    expect(agText).toContain("Gefreiter");
    expect(agText).toContain("Avres");
  });
});
