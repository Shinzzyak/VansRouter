import { describe, it, expect } from "vitest";
import {
  estimateInputTokens,
  estimateOutputTokens,
  estimateUsage,
  addBufferToUsage,
  requestCharsPerToken,
  fixZeroCompletionUsage,
} from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// The estimate produced here is what a buyer sees on the dashboard whenever the
// upstream does not report usage — and, worse, it is what the context guard
// trusts. An estimate that is too LOW lets an oversized request through. So the
// assertions below care about direction as much as about the exact number.

const body = (content, extra = {}) => ({
  model: "test-model",
  messages: [{ role: "user", content }],
  ...extra,
});

const chars = (b) => JSON.stringify(b).length;

const CJK = body("模型路由器令牌估算，这是中文测试文本。".repeat(40));
const EMOJI = body("🔥".repeat(390));
const EN = body("The quick brown fox jumps over the lazy dog. ".repeat(20));
const GEMINI = "ag/gemini-3.8-flash-low";
const GLM = "glm-5.3-flash";

describe("usageTracking — estimates are measured, not assumed", () => {
  it("never undercuts chars/4 on CJK, where /4 overshoots by half", () => {
    const flat = Math.ceil(chars(CJK) / 4);
    const measured = estimateInputTokens(CJK, GEMINI);
    expect(measured).toBeGreaterThan(flat);
    // The measured corpus says CJK costs ~2 tokens per char; anything near /4
    // means the profile was not consulted at all.
    expect(measured / flat).toBeGreaterThan(1.5);
  });

  it("keeps English within a sane distance of chars/4", () => {
    const flat = Math.ceil(chars(EN) / 4);
    const measured = estimateInputTokens(EN, GEMINI);
    expect(measured).toBeGreaterThan(flat * 0.7);
    expect(measured).toBeLessThan(flat * 1.3);
  });

  it("charges emoji at a different rate per family", () => {
    const gemini = estimateInputTokens(EMOJI, GEMINI);
    const glm = estimateInputTokens(EMOJI, GLM);
    expect(gemini).not.toBe(glm);
    // Measured: 390 emoji characters are 389 tokens for Gemini and 598 for GLM.
    // A flat /4 would have called it 97 for both.
    expect(Math.max(gemini, glm)).toBeGreaterThan(390);
  });

  it("counts tool schemas, not just messages", () => {
    const tools = {
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search the corpus",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
    };
    const withTools = estimateInputTokens(body("hi", tools), GEMINI);
    const without = estimateInputTokens(body("hi"), GEMINI);
    expect(withTools).toBeGreaterThan(without);
  });

  it("returns 0 for a body it cannot read", () => {
    expect(estimateInputTokens(null)).toBe(0);
    expect(estimateInputTokens("not an object")).toBe(0);
  });
});

describe("usageTracking — one divisor for both sides", () => {
  it("bills the completion at the same rate as the prompt", () => {
    // CJK: cpt ~1.9, so 400 characters of completion is ~207 tokens, not 100.
    const usage = estimateUsage(CJK, 400, FORMATS.OPENAI, GEMINI);
    const prompt = usage.prompt_tokens - 2000; // addBufferToUsage adds the guard
    const cpt = chars(CJK) / prompt;
    expect(usage.completion_tokens).toBeCloseTo(400 / cpt, 0);
    expect(usage.completion_tokens).toBeGreaterThan(150);
  });

  it("keeps the buffer, the total and the estimated flag", () => {
    const usage = estimateUsage(EN, 400, FORMATS.OPENAI, GEMINI);
    expect(usage.estimated).toBe(true);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
    expect(usage.prompt_tokens).toBeGreaterThan(2000);
  });

  it("speaks Claude when the target format is Claude", () => {
    const usage = estimateUsage(EN, 400, FORMATS.CLAUDE, GEMINI);
    expect(usage.input_tokens).toBeGreaterThan(2000);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.prompt_tokens).toBeUndefined();
  });

  it("falls back to chars/4 when no divisor is known", () => {
    expect(estimateOutputTokens(400)).toBe(100);
    expect(estimateOutputTokens(400, 0)).toBe(100);
    expect(estimateOutputTokens(400, NaN)).toBe(100);
    expect(estimateOutputTokens(400, 2)).toBe(200);
    expect(estimateOutputTokens(0, 2)).toBe(0);
  });

  it("stays finite and bounded on bodies that classify badly", () => {
    // Whitespace, emoji and CJK are the shapes where a naive divisor drifts
    // furthest. The band guard inside charsPerToken exists for a broken engine
    // reading (it cannot be reached with a healthy profile: the coefficients
    // cap chars-per-token between ~0.77 and ~4.8), so what is asserted here is
    // the invariant that matters on the request path — a usable number, never
    // zero, never a division blow-up.
    for (const b of [body(" ".repeat(4000)), EMOJI, CJK]) {
      const usage = estimateUsage(b, 400, FORMATS.OPENAI, GEMINI);
      expect(Number.isFinite(usage.completion_tokens)).toBe(true);
      expect(usage.completion_tokens).toBeGreaterThan(0);
      expect(usage.completion_tokens).toBeLessThanOrEqual(400);
    }
  });

  it("patches a zero-completion usage at the request's own scale", () => {
    // The provider said prompt_tokens: 900, completion_tokens: 0 despite real
    // content. The patch must keep the prompt and bill the output at the same
    // rate the request was measured at — not at a flat four.
    const cpt = requestCharsPerToken(CJK, GEMINI);
    const patched = fixZeroCompletionUsage(
      { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 },
      400,
      cpt
    );
    expect(patched.prompt_tokens).toBe(900);
    expect(patched.estimated).toBe(true);
    expect(patched.completion_tokens).toBeGreaterThan(150);
    expect(patched.total_tokens).toBe(900 + patched.completion_tokens);

    // Without a divisor it still works, just at the rough rate.
    const flat = fixZeroCompletionUsage({ prompt_tokens: 900, completion_tokens: 0 }, 400);
    expect(flat.completion_tokens).toBe(100);
  });

  it("leaves the buffer helper alone", () => {
    const buffed = addBufferToUsage({ prompt_tokens: 10, completion_tokens: 5 });
    expect(buffed.prompt_tokens).toBe(2010);
    expect(buffed.total_tokens).toBe(2010 + 5);
  });
});
