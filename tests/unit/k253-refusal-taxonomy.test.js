import { describe, it, expect, beforeEach } from "vitest";
import { checkFallbackError, recordProviderFailure, clearProviderFailureDedup } from "../../open-sse/services/accountFallback.js";
import { getCircuitBreaker, resetCircuitBreaker } from "../../open-sse/utils/circuitBreaker.js";
import { createErrorResult } from "../../open-sse/utils/error.js";
import { classifyError } from "../../open-sse/utils/errorLog.js";
import { isContentFilterMessage } from "../../open-sse/utils/refusalSignals.js";
import { toOpenAIFinish, fromOpenAIFinish } from "../../open-sse/translator/concerns/finishReason.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

/**
 * K253 — a moderation refusal is a POLICY verdict, not an outage.
 *
 * Live class: DeepSeek over the OpenCode Go relay answers a moderated prompt with
 * HTTP 500 and `{"error":{"message":"Content Exists Risk"}}`. Before this suite
 * that single event (a) cooled a healthy account for 30s, (b) counted toward the
 * provider breaker (5 refusals = every account on the provider blocked), and
 * (c) was classified PROVIDER in the error log, so the engine never learned a
 * refusal had happened.
 */

const DEEPSEEK_500 = "Content Exists Risk";
const DEEPSEEK_502 = "sensitive words detected in the prompt";
const CODEBUDDY_403 = '{"code":11140,"msg":"request illegal","displayMsg":{"en":"The content did not pass the safety review. Please adjust and retry."}}';
const REAL_OUTAGE = "upstream connect error or disconnect/reset before headers";

describe("K253 checkFallbackError — moderation is policy, not credential fault", () => {
  it("DeepSeek 500 Content Exists Risk: no account fallback, no cooldown, flagged", () => {
    const r = checkFallbackError(500, DEEPSEEK_500, 0);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(r.isContentFilter).toBe(true);
  });

  it("relay 502 sensitive words: same verdict", () => {
    const r = checkFallbackError(502, DEEPSEEK_502, 0);
    expect(r.shouldFallback).toBe(false);
    expect(r.isContentFilter).toBe(true);
  });

  it("CodeBuddy 403 code 11140: policy, not auth", () => {
    const r = checkFallbackError(403, CODEBUDDY_403, 0);
    expect(r.shouldFallback).toBe(false);
    expect(r.isContentFilter).toBe(true);
  });

  it("unknown wording still caught by the pattern safety net", () => {
    const r = checkFallbackError(500, "Output was filtered by the safety layer", 0);
    expect(r.shouldFallback).toBe(false);
    expect(r.isContentFilter).toBe(true);
  });

  it("real 500 outage keeps the transient path (no false policy)", () => {
    const r = checkFallbackError(500, REAL_OUTAGE, 0);
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
    expect(r.isContentFilter).toBeUndefined();
  });

  it("real 429 rate limit keeps backoff", () => {
    const r = checkFallbackError(429, "Too many requests", 1);
    expect(r.shouldFallback).toBe(true);
    expect(r.newBackoffLevel).toBe(2);
  });
});

describe("K253 recordProviderFailure — refusals must not open the breaker", () => {
  const provider = "k253-provider";
  const proxy = "direct";

  beforeEach(() => {
    resetCircuitBreaker(`${provider}:${proxy}`);
    clearProviderFailureDedup();
  });

  it("six moderation refusals on 500 leave the breaker CLOSED", () => {
    for (let i = 0; i < 6; i++) {
      recordProviderFailure(provider, 500, DEEPSEEK_500, null, `conn-${i}`, proxy);
    }
    const breaker = getCircuitBreaker(`${provider}:${proxy}`, { failureThreshold: 5 });
    expect(breaker.canExecute()).toBe(true);
  });

  it("six genuine 500s still open it (guard did not neuter the breaker)", () => {
    for (let i = 0; i < 6; i++) {
      recordProviderFailure(provider, 500, REAL_OUTAGE, null, `conn-${i}`, proxy);
    }
    const breaker = getCircuitBreaker(`${provider}:${proxy}`, { failureThreshold: 5 });
    expect(breaker.canExecute()).toBe(false);
  });
});

describe("K253 classifyError — POLICY branch was dead", () => {
  it("createErrorResult derives the policy flag from the message", () => {
    const r = createErrorResult(500, DEEPSEEK_500);
    expect(r.isPolicyError).toBe(true);
    expect(classifyError(r)).toBe("POLICY");
  });

  it("both field names agree", () => {
    const r = createErrorResult(400, CODEBUDDY_403);
    expect(r.policyError).toBe(true);
    expect(r.isPolicyError).toBe(true);
  });

  it("a plain 500 stays PROVIDER", () => {
    expect(classifyError(createErrorResult(502, REAL_OUTAGE))).toBe("PROVIDER");
  });

  it("explicit false wins over the message heuristic", () => {
    expect(classifyError(createErrorResult(500, DEEPSEEK_500, null, false))).toBe("PROVIDER");
  });
});

describe("K253 isContentFilterMessage — taxonomy", () => {
  it("recognises the measured wordings", () => {
    for (const text of [DEEPSEEK_500, DEEPSEEK_502, CODEBUDDY_403, "content management policy", "blocked by the safety system"]) {
      expect(isContentFilterMessage(text)).toBe(true);
    }
  });

  it("ignores outages, quotas and validation", () => {
    for (const text of [REAL_OUTAGE, "insufficient credit", "invalid parameter: temperature", "", null, undefined]) {
      expect(isContentFilterMessage(text)).toBe(false);
    }
  });
});

describe("K253 Claude refusal stop_reason", () => {
  it("claude refusal → content_filter", () => {
    expect(toOpenAIFinish("refusal", "claude")).toBe("content_filter");
  });

  it("content_filter → claude refusal", () => {
    expect(fromOpenAIFinish("content_filter", "claude")).toBe("refusal");
  });

  it("other stop reasons unchanged", () => {
    expect(toOpenAIFinish("end_turn", "claude")).toBe("stop");
    expect(toOpenAIFinish("max_tokens", "claude")).toBe("length");
    expect(toOpenAIFinish("tool_use", "claude")).toBe("tool_calls");
  });
});

describe("K253 replayed reasoning on providers that refuse it", () => {
  const body = () => ({
    model: "llama-3.3-70b",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", reasoning_content: "thought", reasoning: { text: "x" } },
    ],
  });

  it("groq: reasoning fields stripped, transcript intact", () => {
    const b = stripUnsupportedParams("groq", "llama-3.3-70b", body());
    expect(b.messages[1].reasoning_content).toBeUndefined();
    expect(b.messages[1].reasoning).toBeUndefined();
    expect(b.messages[1].content).toBe("hello");
    expect(b.messages[0].content).toBe("hi");
  });

  it("cerebras and mistral: same strip", () => {
    for (const p of ["cerebras", "mistral"]) {
      const b = stripUnsupportedParams(p, "llama-3.3-70b", body());
      expect(b.messages[1].reasoning_content).toBeUndefined();
    }
  });

  it("another provider keeps its replayed reasoning", () => {
    const b = stripUnsupportedParams("openai", "gpt-5.2", body());
    expect(b.messages[1].reasoning_content).toBe("thought");
  });
});
