// K256 — prefill as a RETRY RUNG (not passthrough).
//
// Measured basis: prefill-level jailbreak (arXiv:2504.21038) moves the first-token
// distribution off the refusal branch; it adds 10–15 points on top of prompt-level
// attacks. The router already knew how to FORWARD a client prefill (K225/K227) —
// it never used one itself.
//
// Locked here:
//   1. unknown family => NO trailing assistant turn (Anthropic 400s on it)
//   2. known family   => turn appended + flag set in the body
//   3. marker is non-enumerable => never serialized to the provider
//   4. strip removes only our turn, twice in a row is harmless
//   5. echo guard still removes the opener from the reply
import { describe, it, expect } from "vitest";
import {
  appendPrefillTurn,
  stripPrefillTurn,
  prefillText,
  stripEchoedPrefill,
  applyPrefillFlags,
} from "../../open-sse/rtk/prefill.js";

const body = () => ({
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "task text" },
  ],
});

describe("appendPrefillTurn", () => {
  it("does nothing for a family with no prefill flag (Anthropic)", () => {
    const b = body();
    expect(appendPrefillTurn(b, { provider: "anthropic", model: "claude-sonnet-4" })).toBe(null);
    expect(b.messages[b.messages.length - 1].role).toBe("user");
    expect(b.prefix).toBeUndefined();
    expect(b.partial).toBeUndefined();
  });

  it("appends and flags deepseek (prefix)", () => {
    const b = body();
    expect(appendPrefillTurn(b, { provider: "deepseek", model: "deepseek-v3" })).toBe("prefix");
    expect(b.prefix).toBe(true);
    expect(b.messages[b.messages.length - 1].role).toBe("assistant");
    expect(prefillText(b)).toBeTruthy();
  });

  it("appends and flags qwen (partial)", () => {
    const b = body();
    expect(appendPrefillTurn(b, { provider: "skg", model: "qwen3-max" })).toBe("partial");
    expect(b.partial).toBe(true);
  });

  it("does not duplicate the turn when called twice", () => {
    const b = body();
    appendPrefillTurn(b, { provider: "deepseek", model: "x" });
    appendPrefillTurn(b, { provider: "deepseek", model: "x" });
    expect(b.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("marker never reaches JSON", () => {
    const b = body();
    appendPrefillTurn(b, { provider: "deepseek", model: "x" });
    const wire = JSON.stringify(b);
    expect(wire).not.toContain("vansrouter.prefillTurn");
    expect(Object.keys(b.messages[b.messages.length - 1])).toEqual(["role", "content"]);
  });
});

describe("stripPrefillTurn", () => {
  it("removes our turn and leaves client prefill alone", () => {
    const b = {
      messages: [
        { role: "user", content: "task" },
        { role: "assistant", content: "client supplied" },
      ],
    };
    stripPrefillTurn(b); // no marker => untouched
    expect(b.messages).toHaveLength(2);
    appendPrefillTurn(b, { provider: "deepseek", model: "x" });
    expect(b.messages).toHaveLength(2); // already ended on assistant
    stripPrefillTurn(b);
    expect(b.messages).toHaveLength(2);
    expect(b.messages[1].content).toBe("client supplied");
  });

  it("retry cycle does not stack turns", () => {
    const b = body();
    for (let i = 0; i < 3; i++) {
      stripPrefillTurn(b);
      appendPrefillTurn(b, { provider: "deepseek", model: "x" });
    }
    expect(b.messages).toHaveLength(3);
  });
});

describe("echo guard with an armed prefill", () => {
  it("strips the opener the upstream echoed back", () => {
    const b = body();
    appendPrefillTurn(b, { provider: "deepseek", model: "x" });
    const sent = prefillText(b);
    const reply = `${sent} step one is …`;
    const out = stripEchoedPrefill(sent, reply);
    expect(out.echoed).toBe(true);
    expect(out.text).toBe("step one is …");
  });

  it("applyPrefillFlags is still a no-op on a user-terminated body", () => {
    const b = body();
    expect(applyPrefillFlags(b, { provider: "deepseek", model: "x" })).toBe(false);
  });
});

describe("T13 — ensemble, contextual, reasoning, flagless", () => {
  it("rotates a different opener each attempt", () => {
    const draw = (attempt) => {
      const b = body();
      appendPrefillTurn(b, { provider: "deepseek", model: "x", attempt });
      return prefillText(b);
    };
    const a0 = draw(0);
    const a1 = draw(1);
    const a2 = draw(2);
    expect(a0).toBeTruthy();
    // byte-different samples, not the same frozen string three times
    expect(a0).not.toBe(a1);
    expect(a0).not.toBe(a2);
    expect(a1).not.toBe(a2);
  });

  it("contextual opener names the task's own terms", () => {
    const b = body(); // user content: "task text"
    appendPrefillTurn(b, { provider: "deepseek", model: "x", attempt: 0 });
    expect(prefillText(b)).toMatch(/task text/);
  });

  it("arms a gemini oai-compat body without a body flag", () => {
    const b = body();
    expect(appendPrefillTurn(b, { provider: "openai", model: "gemini-2.5-flash" })).toBe("append");
    expect(b.messages[b.messages.length - 1].role).toBe("assistant");
    expect(b.prefix).toBeUndefined();
    expect(b.partial).toBeUndefined();
  });

  it("never arms a native gemini contents[] body", () => {
    const b = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    expect(appendPrefillTurn(b, { provider: "antigravity", model: "gemini-2.5-flash" })).toBe(null);
    expect(b.contents).toHaveLength(1);
  });

  it("prepends the fabricated reasoning block for a reasoning model", () => {
    const b = body();
    appendPrefillTurn(b, { provider: "deepseek", model: "deepseek-r1", attempt: 1 });
    expect(prefillText(b)).toMatch(/Assessed/);
  });

  it("leaves the reasoning block off a plain chat model", () => {
    const b = body();
    appendPrefillTurn(b, { provider: "deepseek", model: "deepseek-chat", attempt: 1 });
    expect(prefillText(b)).not.toMatch(/Assessed/);
  });

  it("contextual still leads for an unknown-family-but-known-flag model", () => {
    const b = body();
    appendPrefillTurn(b, { provider: "tpr", model: "deepseek-v4.1-flash-1017", attempt: 0 });
    expect(b.prefix).toBe(true);
    expect(prefillText(b)).toMatch(/task text/);
  });
});
