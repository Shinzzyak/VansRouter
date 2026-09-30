import { describe, it, expect } from "vitest";
import { injectBrandContract, BRAND_CONTRACT_MARKER } from "../../open-sse/rtk/brandContract.js";
import { injectPotatoMechanics, POTATO_MECHANICS_MARKER } from "../../open-sse/rtk/potatoMechanics.js";
import { injectThinkingGate, THINKING_GATE_MARKER } from "../../open-sse/rtk/thinkingGate.js";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { engineAvailable } from "./_engineAvailable.js";

/**
 * A Kiro body must be a valid injection TARGET for every persona/contract block.
 *
 * WHY (measured 2026-10-01, second Kiro defect): each injector gates on a
 * `hasContainer()` check that lists messages / input / instructions /
 * systemPrompt / contents. A translated Kiro payload has NONE of those — its
 * conversation lives under `conversationState`. So every one of these blocks
 * skipped silently on Kiro, and the buyer's report ("persona tidak keluar walau
 * toggle max") had a SECOND cause beyond the top-level systemPrompt 400:
 *
 *   injectBrandContract   -> false   (no brand line / seal reaches the model)
 *   injectPotatoMechanics -> false
 *   injectThinkingGate    -> false
 *
 * The bug was masked until now: the old injectKiroSystem wrote a top-level
 * `body.systemPrompt`, which made hasContainer() true by accident on the NEXT
 * block. Removing that write (the 400 fix) exposed the real gap. This is
 * registry class K5 — one predicate, several modules, only one ever patched.
 *
 * Fix: the container predicate must know the Kiro dialect, and it must live in
 * exactly one place (contentWalk.js, already imported by all three).
 */
const CREDENTIALS = {
  providerSpecificData: {
    authMethod: "social",
    profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/TEST",
  },
};

function kiroBody({ withHistory = false } = {}) {
  const payload = openaiToKiroRequest(
    "claude-opus-5-thinking-agentic",
    {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
        ...(withHistory
          ? [
              { role: "assistant", content: "hello" },
              { role: "user", content: "again" },
            ]
          : []),
      ],
    },
    true,
    CREDENTIALS
  );
  return payload;
}

function kiroContent(body) {
  const cur = body.conversationState?.currentMessage?.userInputMessage?.content || "";
  const hist = (body.conversationState?.history || [])
    .map((h) => h?.userInputMessage?.content || "")
    .join("\n");
  return `${hist}\n${cur}`;
}

// The three blocks below are engine-backed on the live router; on a CI runner
// the bundle is absent and they degrade to no-ops, so they skip there. The
// public brandContract assertion still runs everywhere.
describe("Kiro bodies are valid injection containers", () => {
  it("brand contract reaches a Kiro body", () => {
    const body = kiroBody();
    const injected = injectBrandContract(body, "kiro", { chatSurface: true });

    expect(injected).toBe(true);
    expect(kiroContent(body)).toContain(BRAND_CONTRACT_MARKER);
    expect(kiroContent(body)).toContain("MADE BY: GEFREITER");
    expect(body).not.toHaveProperty("systemPrompt");
  });

  it("brand contract reaches a Kiro body that already carries history", () => {
    const body = kiroBody({ withHistory: true });
    expect(injectBrandContract(body, "kiro", { chatSurface: true })).toBe(true);
    expect(kiroContent(body)).toContain(BRAND_CONTRACT_MARKER);
    expect(body).not.toHaveProperty("systemPrompt");
  });

  it("brand contract still skips a JSON-output caller", () => {
    const body = kiroBody();
    body.response_format = { type: "json_object" };
    expect(injectBrandContract(body, "kiro", { chatSurface: true })).toBe(false);
    expect(kiroContent(body)).not.toContain(BRAND_CONTRACT_MARKER);
  });

  describe.skipIf(!engineAvailable())("engine-backed blocks", () => {
    it("potato mechanics reaches a Kiro body", () => {
      const body = kiroBody();
      expect(injectPotatoMechanics(body, "kiro")).toBe(true);
      expect(kiroContent(body)).toContain(POTATO_MECHANICS_MARKER);
      expect(body).not.toHaveProperty("systemPrompt");
    });

    it("thinking gate reaches a thinking Kiro model", () => {
      const body = kiroBody();
      expect(
        injectThinkingGate(body, "kiro", "kiro", "claude-opus-5-thinking-agentic")
      ).toBe(true);
      expect(kiroContent(body)).toContain(THINKING_GATE_MARKER);
      expect(body).not.toHaveProperty("systemPrompt");
    });
  });
});
