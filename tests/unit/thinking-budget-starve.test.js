// A thinking model starves when the caller's max_tokens is smaller than the reasoning
// it needs. Measured on a live reasoning seat 2026-10-25: max_tokens=700 ->
// completion_tokens=700, content "", 51 of 96 probes (53%) blank; the same prompts at
// max_tokens=3000 answered ~3000 chars.
//
// Two cures, chosen by whether the model lets thinking be turned off:
//  - canDisable true  -> honor the caller's cap, turn thinking off (cap is a contract)
//  - canDisable false -> thinking is mandatory, so raise the ceiling to a floor
// Neither path touches a request where the caller asked for enough tokens.
import { describe, it, expect, beforeAll } from "vitest";

let executor;
const FLOOR = 2048;

beforeAll(async () => {
  const mod = await import("../../open-sse/executors/default.js");
  const DefaultExecutor = mod.default?.default || mod.default || mod.DefaultExecutor;
  executor = Object.create(DefaultExecutor.prototype);
});

const run = (provider, model, body) => {
  executor.provider = provider;
  return executor.ensureThinkingBudget({ ...body }, model);
};

describe("thinking-budget starve guard", () => {
  it("honors a small cap by turning thinking off when the model allows it", () => {
    const out = run("deepseek", "deepseek-v4.1-flash", { max_tokens: 700 });
    expect(out.max_tokens).toBe(700);
    expect(out.thinking?.type).toBe("disabled");
    expect(out.extra_body?.thinking?.type).toBe("disabled");
  });

  it("raises the ceiling when thinking cannot be disabled", () => {
    const out = run("nvidia", "minimaxai/minimax-m2.7", { max_tokens: 700 });
    expect(out.max_tokens).toBeGreaterThanOrEqual(FLOOR);
  });

  it("leaves a sufficient budget alone", () => {
    const out = run("deepseek", "deepseek-v4.1-flash", { max_tokens: 16000 });
    expect(out.max_tokens).toBe(16000);
    expect(out.thinking).toBeUndefined();
  });

  it("never invents a max_tokens when the client omitted one", () => {
    const out = run("deepseek", "deepseek-v4.1-flash", {});
    expect(out.max_tokens).toBeUndefined();
  });

  it("does not touch a non-reasoning model", () => {
    const out = run("openai-compatible-x", "gpt-4o-mini", { max_tokens: 200 });
    expect(out.max_tokens).toBe(200);
    expect(out.thinking).toBeUndefined();
  });

  it("respects a client that already disabled thinking", () => {
    const out = run("deepseek", "deepseek-v4.1-flash", { max_tokens: 700, thinking: { type: "disabled" } });
    expect(out.max_tokens).toBe(700);
    expect(out.extra_body).toBeUndefined();
  });

  it("does not override a client that explicitly asked for thinking", () => {
    const out = run("deepseek", "deepseek-v4.1-flash", { max_tokens: 700, thinking: { type: "enabled" } });
    expect(out.thinking?.type).toBe("enabled");
  });

  it("honors a small kimi-nvidia cap unchanged (existing contract)", () => {
    const out = run("nvidia", "moonshotai/kimi-k2.6", { max_tokens: 2048 });
    expect(out.max_tokens).toBe(2048);
  });
});
