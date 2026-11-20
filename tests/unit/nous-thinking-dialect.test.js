import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import nous from "../../open-sse/providers/registry/nous.js";

// Ported from 9router-go internal/providers/nous.go ApplyNousThinking, verified
// against the live inference API rather than assumed from the Go source.
//
// Measured on qwen/qwen4-max:free (prompt "What is 17*23?", max_tokens 3000):
//   enable_thinking:false        -> reasoning 12ch, 16 completion tokens (IGNORED)
//   thinking:{type:"disabled"}   -> reasoning 12ch, 16 completion tokens (IGNORED)
//   reasoning:{enabled:false}    -> reasoning  0ch,  4 completion tokens (HONOURED)
//   reasoning:{effort:"none"}    -> reasoning  0ch,  4 completion tokens (HONOURED)
//
// Before this port the qwen family pattern won for nous/qwen4-max, so the router
// emitted enable_thinking:false and could never actually stop Nous thinking —
// the same budget-starve/blank-content failure documented in executors/default.js.
const MODEL = "qwen/qwen4-max:free";

describe("nous thinking dialect (reasoning:{enabled,effort})", () => {
  it("registry declares the nous format so the qwen family pattern cannot win", () => {
    expect(PROVIDERS.nous?.thinkingFormat).toBe("nous");
  });

  it('effort "none" omits reasoning entirely — the only disable Nous honours', () => {
    const out = applyThinking(FORMATS.OPENAI, MODEL, { reasoning_effort: "none" }, "nous");
    expect(out.reasoning).toBeUndefined();
    expect(out.enable_thinking).toBeUndefined();
    expect(out.thinking).toBeUndefined();
  });

  it.each(["low", "medium", "high"])('effort "%s" → nested reasoning object', (level) => {
    const out = applyThinking(FORMATS.OPENAI, MODEL, { reasoning_effort: level }, "nous");
    expect(out.reasoning).toEqual({ enabled: true, effort: level });
  });

  it('effort "auto" resolves to medium (Nous has no auto wire value)', () => {
    const out = applyThinking(FORMATS.OPENAI, MODEL, { reasoning_effort: "auto" }, "nous");
    expect(out.reasoning).toEqual({ enabled: true, effort: "medium" });
  });

  it("Claude output_config.effort reaches the same dialect", () => {
    const out = applyThinking(FORMATS.OPENAI, MODEL, { output_config: { effort: "high" } }, "nous");
    expect(out.reasoning).toEqual({ enabled: true, effort: "high" });
  });

  it("strips foreign dialects so enable_thinking/thinking never leak upstream", () => {
    const out = applyThinking(
      FORMATS.OPENAI,
      MODEL,
      { reasoning_effort: "low", enable_thinking: true, thinking_budget: 4096, thinking: { type: "enabled" } },
      "nous"
    );
    expect(out.enable_thinking).toBeUndefined();
    expect(out.thinking_budget).toBeUndefined();
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning).toEqual({ enabled: true, effort: "low" });
  });

  it("exposes the none/low/medium/high ladder", () => {
    expect(getThinkingLevels("nous", MODEL)).toEqual(["none", "low", "medium", "high"]);
  });
});

describe("nous registry catalogue (verified against live /v1/models)", () => {
  // The previous snapshot was 7/8 dead upstream: laguna-s/xs-2.1, hy3, solar-pro4,
  // longcat-2.0 and both hermes-4 weights all 404. Routing to them was a stability
  // bug, not a cosmetic staleness.
  const DEAD = [
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
    "tencent/hy3:free",
    "upstage/solar-pro4:free",
    "meituan/longcat-2.0:free",
    "NousResearch/hermes-4-405b",
    "NousResearch/hermes-4-70b",
  ];

  it("carries no model that the live catalogue dropped", () => {
    const ids = nous.models.map((m) => m.id);
    for (const dead of DEAD) expect(ids).not.toContain(dead);
  });

  it("lists the five live free models with the provider's own windows", () => {
    const byId = Object.fromEntries(nous.models.map((m) => [m.id, m]));
    expect(byId["tencent/hy4-flash:free"].contextLength).toBe(1048576);
    expect(byId["meituan/longcat-2.5:free"].contextLength).toBe(1048576);
    expect(byId["qwen/qwen4-max:free"].contextLength).toBe(1000000);
    expect(byId["qwen/qwen4-max:free"].maxOutputTokens).toBe(131072);
    expect(byId["upstage/solar-mini4:free"].contextLength).toBe(524288);
    expect(byId["stepfun/step-3.7-flash:free"].maxOutputTokens).toBe(256000);
    expect(nous.models).toHaveLength(5);
  });
});

describe("nous oauth scope (agent-key mint)", () => {
  it("requests mint_agent_key so a 2h agent key can replace the 1h access token", () => {
    // Verified live: POST /api/oauth/agent-key with an inference:invoke-only token
    // answers 403 insufficient_scope naming inference:mint_agent_key.
    expect(nous.oauth.scope).toContain("inference:invoke");
    expect(nous.oauth.scope).toContain("inference:mint_agent_key");
    expect(nous.oauth.agentKeyUrl).toBe("https://portal.nousresearch.com/api/oauth/agent-key");
  });
});