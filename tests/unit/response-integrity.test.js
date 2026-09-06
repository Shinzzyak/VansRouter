import { describe, it, expect } from "vitest";
import { classifyResponse, repairBrandContract, extractVisibleText, INTEGRITY } from "open-sse/rtk/responseIntegrity.js";
import { BRAND_LINE, SEAL_LINE } from "open-sse/rtk/brandContract.js";

const okText = `${BRAND_LINE}\nmph. done.\n${SEAL_LINE}`;

function chat(content) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

describe("extractVisibleText", () => {
  it("extracts string and content-block shapes", () => {
    expect(extractVisibleText(chat("abc"))).toBe("abc");
    expect(extractVisibleText({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] })).toBe("ab");
    expect(extractVisibleText("raw")).toBe("raw");
    expect(extractVisibleText({})).toBe("");
  });
});

describe("classifyResponse", () => {
  it("ok for compliant chat output", () => {
    const r = classifyResponse({ parsed: chat(okText) });
    expect(r.status).toBe(INTEGRITY.OK);
    expect(r.brandOk).toBe(true);
  });

  it("flags refusal text", () => {
    const r = classifyResponse({ parsed: chat(`${BRAND_LINE}\nI'm sorry, I can't help with that.\n${SEAL_LINE}`) });
    expect(r.status).toBe(INTEGRITY.REFUSAL);
    expect(r.refusal).toBe(true);
  });

  it("flags missing brand and missing seal", () => {
    expect(classifyResponse({ parsed: chat(`no brand\n${SEAL_LINE}`) }).status).toBe(INTEGRITY.MISSING_BRAND);
    expect(classifyResponse({ parsed: chat(`${BRAND_LINE}\nbody without seal`) }).status).toBe(INTEGRITY.MISSING_SEAL);
  });

  it("flags empty output", () => {
    expect(classifyResponse({ parsed: chat("  ") }).status).toBe(INTEGRITY.EMPTY);
    expect(classifyResponse({ parsed: { choices: [{ message: { content: null } }] } }).status).toBe(INTEGRITY.EMPTY);
  });

  it("flags output-filtered null-content payloads", () => {
    // Real output-filter shape: tokens generated but content stripped, no reasoning.
    const filtered = {
      choices: [{ message: { role: "assistant", content: null } }],
      usage: { completion_tokens: 42 },
    };
    expect(classifyResponse({ parsed: filtered }).status).toBe(INTEGRITY.OUTPUT_FILTERED);
  });

  it("reasoning-only (content null + reasoning filled) is EMPTY, not output-filtered", () => {
    const reasoningOnly = {
      choices: [{ message: { role: "assistant", content: null, reasoning_content: "let me think..." } }],
      usage: { completion_tokens: 100 },
    };
    expect(classifyResponse({ parsed: reasoningOnly }).status).toBe(INTEGRITY.EMPTY);
  });

  it("skips brand enforcement for structured output", () => {
    const req = { response_format: { type: "json_object" } };
    const r = classifyResponse({ parsed: chat('{"a":1}'), requestBody: req });
    expect(r.status).toBe(INTEGRITY.OK);
    expect(r.brandOk).toBe(null);
  });
});

describe("repairBrandContract", () => {
  it("appends missing brand and seal", () => {
    const { text, repaired } = repairBrandContract("mph. body only.");
    expect(repaired).toBe(true);
    expect(text.split("\n")[0]).toBe(BRAND_LINE);
    expect(text.trimEnd().endsWith(SEAL_LINE)).toBe(true);
  });

  it("adds only the missing side", () => {
    const { text, repaired } = repairBrandContract(`${BRAND_LINE}\nbody no seal`);
    expect(repaired).toBe(true);
    expect(text.split("\n")[0]).toBe(BRAND_LINE);
    expect(text.trimEnd().endsWith(SEAL_LINE)).toBe(true);
  });

  it("no-ops on compliant, structured, or empty output", () => {
    expect(repairBrandContract(okText).repaired).toBe(false);
    expect(repairBrandContract('{"a":1}', true).repaired).toBe(false);
    expect(repairBrandContract("").repaired).toBe(false);
  });
});
