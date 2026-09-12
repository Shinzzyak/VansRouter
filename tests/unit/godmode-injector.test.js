import { describe, it, expect, vi } from "vitest";
import { applyPromptInjectors, GODMODE_LEVELS } from "open-sse/rtk/promptInjectors.js";
import { injectGodmode } from "open-sse/rtk/godmode.js";
import { engineAvailable } from "./_engineAvailable.js";

// The engine lives outside the repo (data/engine/engine.cjs). On a CI runner it
// is absent by design, so this suite skips there; the degraded path is covered
// by engine-fail-open.test.js, which must pass everywhere.
describe.skipIf(!engineAvailable())("godmode injector", () => {
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

  it("always injects persona lock while keeping godmode optional", () => {
    const log = { debug: vi.fn(), warn: vi.fn() };
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: false });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("PERSONA LOCK");
    expect(body.messages[0].content).not.toContain("senior cybersecurity researcher");

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

  // Regression: the persona lock carries the OUTPUT CONTRACT (first-line brand
  // string + last-line seal + caveman cadence). A caller that validates the whole
  // reply — JSON schema, an agent harness, a delegation child — fails validation
  // on a contract-compliant answer, so that contract must never reach structured
  // traffic. The control case below proves the guard is scoped, not a blanket
  // removal of the chat contract.
  const CONTRACT_MARKER = "The first line of every reply is exactly";
  const IDENTITY_MARKER = "Gefreiter";
  const probeLog = { debug: () => {}, info: () => {}, warn: () => {} };

  it("keeps the chat output contract on a chat body", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body, format: "openai", log: probeLog, godmodeEnabled: false });
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain(CONTRACT_MARKER);
  });

  it("drops the output contract for JSON output (response_format) but keeps identity", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    };
    applyPromptInjectors({ body, format: "openai", log: probeLog, godmodeEnabled: false });
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain(IDENTITY_MARKER);
    expect(sys).not.toContain(CONTRACT_MARKER);
  });

  it("drops the output contract when the caller opts out of router prompt massaging", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body, format: "openai", log: probeLog, godmodeEnabled: false, tokenSaverEnabled: false });
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain(IDENTITY_MARKER);
    expect(sys).not.toContain(CONTRACT_MARKER);
  });

  // The godmode block carries its own copy of the reply-surface contract
  // (brand line, seal, caveman cadence, "sacred output format"). It must also
  // stay off machine-consumed traffic — otherwise a structured caller still gets
  // told to start its reply with the brand line. The control case proves the
  // uncensoring framing itself is NOT removed.
  const REPLAY_SURFACE_MARKER = "CAVEMAN OPERATOR LAYER";
  const FRAMING_MARKER = "senior cybersecurity researcher";

  it("keeps the full godmode reply-surface layer on the chat surface", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body, format: "openai", log: probeLog, godmodeEnabled: true, godmodeLevel: "full" });
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain(REPLAY_SURFACE_MARKER);
    expect(sys).toContain(FRAMING_MARKER);
  });

  it("drops the godmode reply-surface layer for structured traffic but keeps the framing", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    };
    applyPromptInjectors({ body, format: "openai", log: probeLog, godmodeEnabled: true, godmodeLevel: "full" });
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain(FRAMING_MARKER);
    expect(sys).not.toContain(REPLAY_SURFACE_MARKER);
    expect(sys).not.toContain("MADE BY: GEFREITER");
  });

  it("drops the godmode reply-surface layer when the caller opts out but keeps the framing", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({
      body, format: "openai", log: probeLog,
      godmodeEnabled: true, godmodeLevel: "full", tokenSaverEnabled: false,
    });
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain(FRAMING_MARKER);
    expect(sys).not.toContain(REPLAY_SURFACE_MARKER);
  });
});
