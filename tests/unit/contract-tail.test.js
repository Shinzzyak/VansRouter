import { describe, it, expect } from "vitest";
import { applyPromptInjectors } from "../../open-sse/rtk/promptInjectors.js";
import { BLOCK_IDS } from "../../open-sse/rtk/instructionPlan.js";
import { BRAND_LINE, SEAL_LINE, CONTRACT_TAIL_TEXT, CONTRACT_TAIL_MARKER } from "../../open-sse/rtk/brandContract.js";

const log = { debug: () => {}, info: () => {}, warn: () => {} };

// R1 (G1+G2) — riset persona/system-prompt 2026-10-05.
// ATURAN YANG DIJAGA: kontrak brand bukan cuma pernyataan di tengah rantai
// injeksi — ia HARUS diulang sebagai paragraf TERAKHIR dari system text, karena
// literatur posisi (U-curve, terminal constraint degradation) mengukur bahwa
// instruksi di paragraf terakhir prompt jauh lebih awet daripada head-only.
// Tanpa tail ini, brand contract saja terbukti kurang: potato/thinking-gate
// menutup rantai, sehingga kontrak bukan teks sistem terakhir.

const sysText = (body) =>
  body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n---\n");

describe("contract tail — reassert kontrak di paragraf terakhir prompt", () => {
  it("exports a non-empty CONTRACT_TAIL_TEXT with both canon lines", () => {
    expect(typeof CONTRACT_TAIL_TEXT).toBe("string");
    expect(CONTRACT_TAIL_TEXT.length).toBeGreaterThan(20);
    expect(CONTRACT_TAIL_TEXT).toContain(BRAND_LINE);
    expect(CONTRACT_TAIL_TEXT).toContain(SEAL_LINE);
  });

  it("CONTRACT_TAIL is a registered block id", () => {
    expect(BLOCK_IDS.CONTRACT_TAIL).toBeTruthy();
    expect(BLOCK_IDS.CONTRACT_TAIL).toBe("contract_tail");
  });

  it("the tail is the LAST system text on a full chat request", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    applyPromptInjectors({
      body,
      format: "openai",
      log,
      godmodeEnabled: true,
      godmodeLevel: "full",
      bypassMode: "framing",
      provider: "bai",
      model: "deepseek-v4-flash-vision-exp",
    });
    const text = sysText(body);
    const iTail = text.indexOf("CONTRACT TAIL");
    const iPotato = text.indexOf("ROAST PROTOCOL");
    expect(iTail).toBeGreaterThanOrEqual(0);
    if (iPotato >= 0) expect(iTail).toBeGreaterThan(iPotato); // tail rides AFTER potato
    // G2: final system content carries the restated contract.
    const lastSystem = [...body.messages].reverse().find((m) => m.role === "system");
    expect(lastSystem.content).toContain("CONTRACT TAIL");
    expect(lastSystem.content).toContain(BRAND_LINE);
    expect(lastSystem.content).toContain(SEAL_LINE);
    // The tail is literally the last contract occurrence in the whole system text.
    const iLastSeal = text.lastIndexOf(SEAL_LINE);
    expect(iLastSeal).toBeGreaterThan(text.indexOf(SEAL_LINE));
    expect(iTail).toBeLessThanOrEqual(iLastSeal);
  });

  it("plan records contract_tail as the last block when applied", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const receipt = applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: true });
    expect(receipt.blocks[receipt.blocks.length - 1].id).toBe(BLOCK_IDS.CONTRACT_TAIL);
    const tailBlock = receipt.blocks.find((b) => b.id === BLOCK_IDS.CONTRACT_TAIL);
    expect(tailBlock).toBeTruthy();
    expect(tailBlock.injectorStatus).toBe("ok");
    expect(sysText(body)).toContain("CONTRACT TAIL");
  });

  it("is skipped for JSON-output requests (brand lines must not corrupt output)", () => {
    const body = { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } };
    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: true });
    expect(JSON.stringify(body).includes("CONTRACT TAIL")).toBe(false);
  });

  it("is skipped for persona-exempt keys (clean pipe = zero owner contract)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({
      body,
      format: "openai",
      log,
      godmodeEnabled: true,
      apiKeyInfo: { personaInject: false },
    });
    const text = sysText(body);
    expect(text.includes("CONTRACT TAIL")).toBe(false);
    expect(text.includes(BRAND_LINE)).toBe(false);
  });

  it("still injects when godmode/bypass are off (persona always-on path)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyPromptInjectors({ body, format: "openai", log });
    expect(sysText(body)).toContain("CONTRACT TAIL");
  });

  // R2 gap found by measurement (2026-10-05): hasContainer() never recognised
  // the Gemini dialect, so BOTH contract blocks silently skipped every
  // gemini/vertex/antigravity body — same class as the Kiro skip fixed
  // 2026-10-01 (measured, acknowledged in hasContainer's own comment). The
  // underlying injectGeminiSystem handles both shapes (creates
  // systemInstruction when absent), so the container gate was the only
  // blocker. Tripwire test: fails if the gate regresses.
  it("lands on the gemini dialect (bare contents body)", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
    applyPromptInjectors({ body, format: "gemini", log, godmodeEnabled: true });
    const text = JSON.stringify(body);
    expect(text).toContain("CONTRACT TAIL");
    expect(text).toContain(BRAND_LINE);
    expect(text).toContain(SEAL_LINE);
  });

  it("lands on the gemini dialect (pre-existing systemInstruction body)", () => {
    const body = {
      systemInstruction: { parts: [{ text: "base" }] },
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    };
    applyPromptInjectors({ body, format: "gemini", log, godmodeEnabled: true });
    const text = JSON.stringify(body);
    expect(text).toContain("CONTRACT TAIL");
    expect(text).toContain(BRAND_LINE);
  });
});
