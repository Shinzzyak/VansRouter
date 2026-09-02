import { describe, it, expect } from "vitest";
import {
  detectCompactionHandoff,
  reassertPersonaAfterCompaction,
  COMPACTION_REASSERT_PROMPT,
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
