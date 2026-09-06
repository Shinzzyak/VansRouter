import { describe, it, expect } from "vitest";
import { applyPromptInjectors } from "open-sse/rtk/promptInjectors.js";
import { BRAND_LINE } from "open-sse/rtk/brandContract.js";

const silentLog = { debug() {}, info() {}, warn() {} };

function openaiBody(text = "hello") {
  return { messages: [{ role: "user", content: text }] };
}

describe("applyPromptInjectors — plan + receipt wiring", () => {
  it("returns a receipt with applied blocks", () => {
    const receipt = applyPromptInjectors({
      body: openaiBody(), format: "openai", log: silentLog,
      godmodeEnabled: true, provider: "gemini", model: "gemini-3-flash",
    });
    expect(receipt).toBeTruthy();
    expect(Array.isArray(receipt.blocks)).toBe(true);
    const applied = receipt.blocks.filter((b) => b.applied).map((b) => b.id);
    expect(applied).toContain("owner_identity");
    expect(applied).toContain("godmode_behavior");
    expect(applied).toContain("output_contract");
  });

  it("receipt marks godmode applied=ok after injection", () => {
    const receipt = applyPromptInjectors({
      body: openaiBody(), format: "openai", log: silentLog, godmodeEnabled: true,
    });
    const god = receipt.blocks.find((b) => b.id === "godmode_behavior");
    expect(god.injectorStatus).toBe("ok");
  });

  it("structured output skips chat blocks in the plan", () => {
    const body = openaiBody();
    body.response_format = { type: "json_object" };
    const receipt = applyPromptInjectors({
      body, format: "openai", log: silentLog, godmodeEnabled: true,
    });
    const god = receipt.blocks.find((b) => b.id === "godmode_behavior");
    expect(god.applied).toBe(false);
    expect(god.skipReason).toBe("target_mismatch");
  });

  it("compaction block present when handoff detected", () => {
    const body = { messages: [{ role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] summary" }, { role: "user", content: "real" }] };
    const receipt = applyPromptInjectors({ body, format: "openai", log: silentLog });
    const comp = receipt.blocks.find((b) => b.id === "compaction_reassert");
    expect(comp).toBeTruthy();
    expect(comp.applied).toBe(true);
  });

  it("no compaction block on a plain request", () => {
    const receipt = applyPromptInjectors({ body: openaiBody(), format: "openai", log: silentLog });
    expect(receipt.blocks.find((b) => b.id === "compaction_reassert")).toBeUndefined();
  });

  it("persona + brand still land in the body (injection not broken by plan)", () => {
    const body = openaiBody();
    applyPromptInjectors({ body, format: "openai", log: silentLog });
    const sys = JSON.stringify(body);
    expect(sys).toContain("Gefreiter");
    expect(sys).toContain(BRAND_LINE);
  });

  it("never throws on a container-less body (fail-open)", () => {
    expect(() => applyPromptInjectors({ body: {}, format: "openai", log: silentLog })).not.toThrow();
  });
});
