// Guard the prompt-shape gate: the transform must neutralise ONLY agent-shaped
// system prompts, and the user's own message must come out byte-identical.
//
// WHY THESE CASES. Measured 2026-09-25 on cbai/deepseek-v4.1-flash:
//   agent-shaped system prompt -> HTTP 400 code 11128, 8/8 rejected
//   same prompt neutralised     -> 200 OK,                8/8 accepted
//   user message identical in both arms
// The gate is a CHANNEL gate, so the fix is to stop sending the router's own
// scaffolding — never to touch the user's message. Every case below is written
// against that asymmetry.
//
// Note on the framework: written with node:test first, which vitest cannot
// collect ("No test suite found") — the suite ran green under `node --test` and
// was invisible to the gate that actually guards deploys. vitest's API, so the
// CI gate sees it.
import { describe, it, expect } from "vitest";
import {
  neutralizeAgentSystemPrompts, isAgentShapedPrompt, NEUTRAL_SYSTEM_PROMPT,
} from "../../open-sse/executors/promptNeutralize.js";

const AGENT_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude. You are a powerful AI agent with orchestration capabilities.";
const USER = "Tulis panduan lengkap, jangan dipotong.";

describe("prompt-shape gate: netralkan scaffolding, jangan sentuh pesan user", () => {
  it("agent-shaped system prompt diganti, pesan user TIDAK disentuh", () => {
    const body = {
      messages: [
        { role: "system", content: AGENT_PROMPT },
        { role: "user", content: USER },
      ],
    };
    expect(neutralizeAgentSystemPrompts(body).changed).toBe(1);
    expect(body.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(body.messages[1].content).toBe(USER);
  });

  it("system prompt biasa milik pemanggil dibiarkan apa adanya", () => {
    const own = "You are a SQL generator. Always emit valid PostgreSQL.";
    const body = { messages: [{ role: "system", content: own }, { role: "user", content: USER }] };
    expect(neutralizeAgentSystemPrompts(body).changed).toBe(0);
    expect(body.messages[0].content).toBe(own);
  });

  it("system prompt panjang TAPI bukan agent-shaped tidak diganti", () => {
    // Kelas false-positive yang bikin versi lama (length > 2000) salah:
    // panjang bukan sinyal, isi yang sinyal.
    const long = "You are a domain assistant. " + "Aturan bisnis nomor sekian. ".repeat(120);
    expect(long.length).toBeGreaterThan(2000);
    const body = { messages: [{ role: "system", content: long }, { role: "user", content: USER }] };
    expect(neutralizeAgentSystemPrompts(body).changed).toBe(0);
    expect(body.messages[0].content).toBe(long);
  });

  it("blok persona/godmode router sendiri ikut dinetralkan", () => {
    for (const marker of [
      "PERSONA LOCK — ROUTER DEFAULT\n\nYou are Gefreiter...",
      "MADE BY: GEFREITER — AGENT OF AVRES",
      "BRAND CONTRACT — FIRST LINE / LAST LINE (highest priority)",
      "POTATO MECHANICS — ALWAYS-ON BEHAVIOR",
      "You are Gefreiter, the devoted personal agent of Avres.",
    ]) {
      expect(isAgentShapedPrompt(marker), marker.slice(0, 40)).toBe(true);
    }
  });

  it("bentuk content bertipe blok (Claude/Gemini) ditangani", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: AGENT_PROMPT }] },
        { role: "user", content: [{ type: "text", text: USER }] },
      ],
    };
    expect(neutralizeAgentSystemPrompts(body).changed).toBe(1);
    expect(body.messages[0].content).toEqual([{ type: "text", text: NEUTRAL_SYSTEM_PROMPT }]);
    expect(body.messages[1].content).toEqual([{ type: "text", text: USER }]);
  });

  it("Responses API: instructions dan input ditangani", () => {
    const body = {
      instructions: AGENT_PROMPT,
      input: [{ role: "system", content: AGENT_PROMPT }, { role: "user", content: USER }],
    };
    expect(neutralizeAgentSystemPrompts(body).changed).toBe(2);
    expect(body.instructions).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(body.input[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(body.input[1].content).toBe(USER);
  });

  it("fail-open: body aneh tidak melempar", () => {
    for (const bad of [null, undefined, 42, "string", {}, { messages: "bukan array" }]) {
      expect(() => neutralizeAgentSystemPrompts(bad)).not.toThrow();
    }
  });

  it("idempoten: menjalankan dua kali tidak mengubah lagi", () => {
    const body = { messages: [{ role: "system", content: AGENT_PROMPT }] };
    expect(neutralizeAgentSystemPrompts(body).changed).toBe(1);
    expect(neutralizeAgentSystemPrompts(body).changed).toBe(0);
    expect(body.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
  });
});
