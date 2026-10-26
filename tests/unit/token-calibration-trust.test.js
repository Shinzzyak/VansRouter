import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  isPromptUsageAuthoritative,
  formatUsage,
  fixZeroCompletionUsage,
  estimateUsage,
} from "../../open-sse/utils/usageTracking.js";
import * as sseToJson from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
const convertUsage = sseToJson[Object.keys(sseToJson).find((k) => k.startsWith("responsesUsage"))];
import {
  observePrompt,
  resetCalibration,
  calibrationTable,
  estimatePromptTokens,
} from "../../open-sse/rtk/tokenProfile.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// K238 — the calibration table may only learn from the provider's own prompt
// count. Before this guard, a client whose upstream stayed silent could feed
// the loop its own estimates and walk the family factor to its 0.5 floor,
// making every later request on that family bill roughly half.
//
// Two layers are asserted: the provenance flag itself (behavior), and the
// wiring that makes the flag load-bearing (source scan — a call site that
// silently drops the gate passes every behavior test above while shipping
// the bug).

describe("K238 — prompt usage provenance", () => {
  it("rejects synthesized, empty and malformed usage", () => {
    expect(isPromptUsageAuthoritative(null)).toBe(false);
    expect(isPromptUsageAuthoritative(undefined)).toBe(false);
    expect(isPromptUsageAuthoritative({})).toBe(false);
    expect(isPromptUsageAuthoritative({ prompt_tokens: 0 })).toBe(false);
    expect(isPromptUsageAuthoritative({ prompt_tokens: "900" })).toBe(false);
    expect(isPromptUsageAuthoritative({ prompt_tokens: NaN })).toBe(false);
    expect(isPromptUsageAuthoritative({ prompt_tokens: 900, prompt_estimated: true })).toBe(false);
    expect(isPromptUsageAuthoritative({ input_tokens: 900, prompt_estimated: true })).toBe(false);
  });

  it("accepts a provider-reported count in either format", () => {
    expect(isPromptUsageAuthoritative({ prompt_tokens: 900 })).toBe(true);
    expect(isPromptUsageAuthoritative({ input_tokens: 900 })).toBe(true);
  });

  it("every synthesized usage object is marked at the source", () => {
    for (const fmt of [FORMATS.OPENAI, FORMATS.CLAUDE]) {
      const u = formatUsage(500, 40, fmt);
      expect(u.prompt_estimated).toBe(true);
      expect(isPromptUsageAuthoritative(u)).toBe(false);
    }
    const est = estimateUsage({ model: "glm", messages: [{ role: "user", content: "x".repeat(4000) }] }, 400);
    expect(est.prompt_estimated).toBe(true);
    expect(isPromptUsageAuthoritative(est)).toBe(false);
  });

  it("an output-only patch keeps the provider's prompt count usable", () => {
    // fixZeroCompletionUsage estimates ONLY the completion side. Rejecting it
    // would throw away real observations for no security gain.
    const fixed = fixZeroCompletionUsage({ prompt_tokens: 1200, completion_tokens: 0 }, 800, 4);
    expect(fixed.estimated).toBe(true);
    expect(fixed.prompt_estimated).toBeUndefined();
    expect(isPromptUsageAuthoritative(fixed)).toBe(true);
  });

  it("the responses->chat conversion cannot launder the flag away", () => {
    const converted = convertUsage({ input_tokens: 800, output_tokens: 10, estimated: true, prompt_estimated: true });
    expect(converted.prompt_tokens).toBe(800);
    expect(converted.prompt_estimated).toBe(true);
    expect(isPromptUsageAuthoritative(converted)).toBe(false);
    const real = convertUsage({ input_tokens: 800, output_tokens: 10 });
    expect(real.prompt_estimated).toBeUndefined();
    expect(isPromptUsageAuthoritative(real)).toBe(true);
  });
});

describe("K238 — the loop itself, driven through the gate", () => {
  beforeEach(() => resetCalibration());

  const body = { model: "glm", messages: [{ role: "user", content: "lorem ipsum dolor sit amet ".repeat(400) }] };
  const factor = () => calibrationTable().find((r) => r.family === "glm")?.factor ?? 1;

  it("30 synthesized observations cannot move the factor", () => {
    const raw = estimatePromptTokens(body, "glm", { calibrate: false });
    for (let i = 0; i < 30; i++) {
      const tokens = { prompt_tokens: Math.round(raw * 0.5), prompt_estimated: true };
      if (isPromptUsageAuthoritative(tokens)) observePrompt("glm", raw, tokens.prompt_tokens);
    }
    expect(factor()).toBe(1);
  });

  it("the same ratio DOES move the factor when the provider reported it", () => {
    const raw = estimatePromptTokens(body, "glm", { calibrate: false });
    for (let i = 0; i < 30; i++) {
      const tokens = { prompt_tokens: Math.round(raw * 0.5) };
      if (isPromptUsageAuthoritative(tokens)) observePrompt("glm", raw, tokens.prompt_tokens);
    }
    expect(raw).toBeGreaterThan(400);
    expect(factor()).toBeCloseTo(0.5, 1);
  });
});

describe("K238 — wiring", () => {
  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

  it("saveUsageStats refuses to learn without authoritative prompt usage", () => {
    const src = read("open-sse/handlers/chatCore/requestDetail.js");
    expect(src).toMatch(/if \(requestBody && isPromptUsageAuthoritative\(tokens\)\)/);
    expect(src).toMatch(/import \{ canonicalizeUsage, isPromptUsageAuthoritative \}/);
  });

  it("no full-synthesis site ships an unmarked prompt count", () => {
    const devin = read("open-sse/executors/devin-cli.js");
    expect(devin).toMatch(/estimated: true,\s*\n\s*prompt_estimated: true,/);
    const usage = read("open-sse/utils/usageTracking.js");
    const formatBody = usage.slice(usage.indexOf("export function formatUsage"), usage.indexOf("export function estimateUsage"));
    expect(formatBody.match(/prompt_estimated: true/g)?.length).toBe(2);
  });
});
