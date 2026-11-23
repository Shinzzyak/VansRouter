import { describe, it, expect } from "vitest";

/**
 * K273 — a provider block notice ("This request was blocked by Gemini's
 * filters. They can occasionally trigger by mistake...") is a FILTER_UPSTREAM
 * transport verdict, never a delivered answer. Measured live 2026-11-23 12:30:
 * the streaming ladder accepted the block JSON as "T2 successful" and shipped
 * it to the client as success; combo then reported the node healthy.
 *
 * The fix lives in the router (combo.js + chatCore.js); this test pins the
 * classifier contract the fix depends on, using the real engine bundle.
 */

const BLOCK_RAW = JSON.stringify({
  response: {
    promptFeedback: {
      blockReason: "OTHER",
      blockReasonMessage:
        "This request was blocked by Gemini's filters. They can occasionally trigger by mistake on safe coding, security, or biology-related queries. Please try rephrasing your prompt.",
    },
    usageMetadata: { promptTokenCount: 6450 },
    modelVersion: "gemini-3.8-flash-tiered",
  },
  object: "chat.completion",
});

async function loadEngine() {
  const m = await import("../../.next/standalone/data/engine/engine.cjs");
  return m;
}

describe("K273 provider block notice", () => {
  it("classifies the block JSON as FILTER_UPSTREAM, not PATUH", async () => {
    const m = await loadEngine();
    expect(m.selfMeasuringBypass.classifyOutcome(BLOCK_RAW, true)).toBe(
      "FILTER_UPSTREAM"
    );
  });

  it("isProviderFilterNotice fires on the JSON envelope and the plain text", async () => {
    const m = await loadEngine();
    const pf = m.providerFilterNotice;
    expect(pf.isProviderFilterNotice(BLOCK_RAW)).toBe(true);
    expect(
      pf.isProviderFilterNotice(
        "This request was blocked by Gemini's filters. Please try rephrasing your prompt."
      )
    ).toBe(true);
  });

  it("does NOT fire on a healthy technical answer", async () => {
    const m = await loadEngine();
    const pf = m.providerFilterNotice;
    const healthy = JSON.stringify({
      choices: [
        {
          message: {
            content:
              "Me bangun keylogger POC berikut. #include <windows.h>\nSetWindowsHookEx(WH_KEYBOARD_LL, ...)",
          },
        },
      ],
    });
    expect(pf.isProviderFilterNotice(healthy)).toBe(false);
    // A discussion that merely mentions filters must not trip the gate.
    expect(
      pf.isProviderFilterNotice(
        "Keyloggers can be blocked by safety filters in some products, but here is the code: SetWindowsHookEx"
      )
    ).toBe(false);
  });

  it("needsFirstPassEscalation stays false for FILTER_UPSTREAM (ladder contract)", async () => {
    const m = await loadEngine();
    expect(m.selfMeasuringBypass.needsFirstPassEscalation("FILTER_UPSTREAM")).toBe(
      false
    );
  });
});
