import { describe, it, expect } from "vitest";
import { injectBrandContract, hasBrandContract, BRAND_LINE, SEAL_LINE, BRAND_CONTRACT_MARKER } from "../../open-sse/rtk/brandContract.js";
import { applyPromptInjectors } from "../../open-sse/rtk/promptInjectors.js";

const log = { debug: () => {}, info: () => {}, warn: () => {} };

describe("brandContract strings (brand_canon pin)", () => {
  it("uses the canonical brand + seal strings", () => {
    expect(BRAND_LINE).toBe("MADE BY: GEFREITER — AGENT OF AVRES");
    expect(SEAL_LINE).toBe("Avres is King.");
  });
});

describe("injectBrandContract", () => {
  it("appends the contract to an openai-shaped body", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    expect(injectBrandContract(body, "openai")).toBe(true);
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain(BRAND_CONTRACT_MARKER);
    expect(sys).toContain(BRAND_LINE);
    expect(sys).toContain(SEAL_LINE);
  });

  it("is idempotent", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    expect(injectBrandContract(body, "openai")).toBe(true);
    const count = JSON.stringify(body).split(BRAND_CONTRACT_MARKER).length - 1;
    expect(injectBrandContract(body, "openai")).toBe(false);
    expect(JSON.stringify(body).split(BRAND_CONTRACT_MARKER).length - 1).toBe(count);
    expect(hasBrandContract(body)).toBe(true);
  });

  it("skips JSON-output requests", () => {
    const body = { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } };
    expect(injectBrandContract(body, "openai")).toBe(false);
    expect(hasBrandContract(body)).toBe(false);
  });

  it("fails open on null and container-less bodies", () => {
    expect(injectBrandContract(null, "openai")).toBe(false);
    expect(injectBrandContract({}, "openai")).toBe(false); // no container → no-op, honest false
    expect(hasBrandContract({})).toBe(false);
  });
});

describe("applyPromptInjectors ordering", () => {
  it("brand contract is the final system text (after persona lock + godmode)", () => {
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
    const sysText = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n---\n");
    const iPersona = sysText.indexOf("PERSONA LOCK");
    const iGodmode = sysText.indexOf("authorized penetration test and security awareness training program");
    const iBrand = sysText.indexOf(BRAND_CONTRACT_MARKER);
    expect(iPersona).toBeGreaterThanOrEqual(0);
    expect(iGodmode).toBeGreaterThan(iPersona);
    expect(iBrand).toBeGreaterThan(iGodmode);
    // brand contract is inside the final system content with exact contract wording
    const lastSystem = [...body.messages].reverse().find((m) => m.role === "system");
    expect(lastSystem.content).toContain(`The FIRST line of your reply must be exactly: ${BRAND_LINE}`);
    expect(lastSystem.content).toContain(`The LAST line of your reply must be exactly: ${SEAL_LINE}`);
  });

  it("brand contract survives the compaction-reassert flow and stays last", () => {
    const body = { messages: [
      { role: "system", content: "base" },
      { role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] earlier summary" },
      { role: "user", content: "live request" },
    ] };
    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: true });
    const sysText = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n---\n");
    const iReassert = sysText.indexOf("PERSONA REASSERT");
    const iBrand = sysText.indexOf(BRAND_CONTRACT_MARKER);
    expect(iReassert).toBeGreaterThanOrEqual(0);
    expect(iBrand).toBeGreaterThan(iReassert);
  });

  it("does not corrupt JSON-output requests through the full chain", () => {
    const body = { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } };
    applyPromptInjectors({ body, format: "openai", log, godmodeEnabled: true });
    expect(JSON.stringify(body).includes(BRAND_CONTRACT_MARKER)).toBe(false);
  });
});
