// K122 — potato is a CHAT-SURFACE block, not an unconditional one.
//
// WHY (2026-10-17 audit). Every other behavioral injector (CAVEMAN, PONYTAIL) is
// gated on `tokenSaverEnabled`; POTATO was gated on `!personaExempt` alone. So a
// caller sending `token-saver: off` — the header that means "my reply must stay
// machine-readable", the same one that shortens the persona lock to
// identity-only — still received the full roast protocol. The lock got shorter,
// the behavior got louder.
//
// This test loads the SERVED engine bundle through the rtk shim, not the source
// tree: the engine repo is a partial mirror (systemInject/caveman/ponytail live
// router-side), so a source-level import cannot resolve. Consequence, and it is
// the point: on a bundle built BEFORE the fix these assertions are RED, which is
// the negative control.
import { describe, it, expect } from "vitest";
import { applyPromptInjectors } from "../../open-sse/rtk/promptInjectors.js";

const MARK = "POTATO MECHANICS";

function run(opts = {}) {
  const body = { model: "glm-5.3", messages: [{ role: "user", content: "hello" }] };
  applyPromptInjectors({
    body,
    format: "openai",
    tokenSaverEnabled: true,
    godmodeEnabled: true,
    ...opts,
  });
  return JSON.stringify(body);
}

const count = (hay, needle) => hay.split(needle).length - 1;

describe("potato gate (K122)", () => {
  it("chat surface gets potato exactly once", () => {
    expect(count(run({ tokenSaverEnabled: true }), MARK)).toBe(1);
  });

  it("token-saver off gets NO potato", () => {
    expect(count(run({ tokenSaverEnabled: false }), MARK)).toBe(0);
  });

  it("persona-exempt key gets no potato", () => {
    expect(count(run({ apiKeyInfo: { personaInject: false } }), MARK)).toBe(0);
  });

  it("double application stays single", () => {
    const body = { model: "glm-5.3", messages: [{ role: "user", content: "hello" }] };
    const opts = { body, format: "openai", tokenSaverEnabled: true, godmodeEnabled: true };
    applyPromptInjectors(opts);
    applyPromptInjectors(opts);
    expect(count(JSON.stringify(body), MARK)).toBe(1);
  });

  it("JSON-output request is skipped internally", () => {
    const body = {
      model: "glm-5.3",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "give me json" }],
    };
    applyPromptInjectors({ body, format: "openai", tokenSaverEnabled: true, godmodeEnabled: true });
    expect(count(JSON.stringify(body), MARK)).toBe(0);
  });
});
