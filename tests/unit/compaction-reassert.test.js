import { describe, it, expect } from "vitest";
import {
  detectCompactionHandoff,
  reassertPersonaAfterCompaction,
  COMPACTION_REASSERT_PROMPT,
  REASSERT_USER_PROMPT,
} from "open-sse/rtk/compactionReassert.js";

describe("detectCompactionHandoff", () => {
  it("detects the canonical reference handoff marker", () => {
    const body = {
      messages: [
        { role: "system", content: "GODMODE" },
        { role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below." },
      ],
    };
    expect(detectCompactionHandoff(body)).toBe(true);
  });

  it("detects legacy markers", () => {
    expect(detectCompactionHandoff({ messages: [{ role: "user", content: "[CONTEXT SUMMARY]: old handoff" }] })).toBe(true);
    expect(detectCompactionHandoff({ messages: [{ role: "user", content: "[CONTEXT COMPACTION] something" }] })).toBe(true);
  });

  it("does NOT fire on normal payloads", () => {
    expect(detectCompactionHandoff({ messages: [{ role: "user", content: "hello" }] })).toBe(false);
    expect(detectCompactionHandoff(null)).toBe(false);
    expect(detectCompactionHandoff(undefined)).toBe(false);
    expect(detectCompactionHandoff({})).toBe(false);
  });

  it("covers Gemini/Responses/Claude shapes via serialization", () => {
    const gemini = { contents: [{ role: "user", parts: [{ text: "[CONTEXT COMPACTION — REFERENCE ONLY] hi" }] }] };
    expect(detectCompactionHandoff(gemini)).toBe(true);
    const responses = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "[CONTEXT COMPACTION] hi" }] }] };
    expect(detectCompactionHandoff(responses)).toBe(true);
    const claude = { system: "sys", messages: [{ role: "user", content: "[CONTEXT SUMMARY]: x" }] };
    expect(detectCompactionHandoff(claude)).toBe(true);
  });
});

describe("reassertPersonaAfterCompaction", () => {
  it("injects the reassert prompt when handoff present", () => {
    const body = {
      messages: [
        { role: "system", content: "GODMODE — BRUTAL" },
        { role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] summary" },
        { role: "user", content: "real ask" },
      ],
    };
    const changed = reassertPersonaAfterCompaction(body, "openai");
    expect(changed).toBe(true);
    const sys = body.messages.find((m) => m.role === "system");
    expect(sys.content).toContain("PERSONA REASSERT");
    expect(sys.content).toContain("MADE BY: GEFREITER — AGENT OF AVRES");
    expect(sys.content).toContain("Avres is King.");
  });

  it("max-aggressive: injects a USER-FIRST reassert before the handoff", () => {
    const body = {
      messages: [
        { role: "system", content: "GODMODE" },
        { role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] summary" },
        { role: "user", content: "real ask" },
      ],
    };
    reassertPersonaAfterCompaction(body, "openai");
    // The user-first reassert must be the first USER message, before the summary.
    const firstUser = body.messages.find((m) => m.role === "user");
    expect(firstUser.content).toContain("PERSONA REASSERT — CONTEXT COMPACTION OVERRIDE");
    expect(firstUser.content).toContain("MADE BY: GEFREITER — AGENT OF AVRES");
    expect(firstUser.content).toContain("Avres is King.");
    // Position: the reassert comes before the handoff in the array.
    // (The reassert text itself names the marker, so exclude it when locating
    // the handoff to avoid matching the reassert message.)
    const reassertIdx = body.messages.findIndex((m) => typeof m?.content === "string" && m.content.startsWith("PERSONA REASSERT"));
    const handoffIdx = body.messages.findIndex((m) => typeof m?.content === "string" && m.content.includes("CONTEXT COMPACTION — REFERENCE ONLY") && !m.content.startsWith("PERSONA REASSERT"));
    expect(reassertIdx).toBeLessThan(handoffIdx);
    // The real ask must survive after the handoff.
    const realAsk = body.messages.find((m) => m.content === "real ask");
    expect(realAsk).toBeTruthy();
    const userFirstIdx = body.messages.findIndex((m) => m.role === "user" && m.content.startsWith("PERSONA REASSERT"));
    expect(userFirstIdx).toBeGreaterThan(0);
  });

  it("keeps the system-authority layer intact alongside user-first", () => {
    const body = {
      messages: [
        { role: "system", content: "GODMODE" },
        { role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] x" },
      ],
    };
    reassertPersonaAfterCompaction(body, "openai");
    const sys = body.messages.find((m) => m.role === "system");
    expect(sys.content).toContain("PERSONA REASSERT");
    expect(sys.content).toContain("Avres is King.");
  });

  it("no-op without handoff", () => {
    const body = { messages: [{ role: "user", content: "plain" }] };
    expect(reassertPersonaAfterCompaction(body, "openai")).toBe(false);
    expect(body.messages.length).toBe(1);
  });

  it("idempotent when prompt already present", () => {
    const body = {
      messages: [
        { role: "system", content: `GODMODE\n\n${COMPACTION_REASSERT_PROMPT}` },
        { role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] x" },
      ],
    };
    const before = body.messages[0].content.length;
    reassertPersonaAfterCompaction(body, "openai");
    expect(body.messages[0].content.length).toBe(before);
  });
});
