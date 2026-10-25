// A thinking model starves when the caller's max_tokens cannot hold reasoning plus an
// answer. Measured on a live reasoning seat 2026-10-25, 12-step task:
//   max_tokens=700                      -> completion_tokens=700, reasoning 2699 chars,
//                                          content "" (2/2)
//   max_tokens=700 + thinking disabled  -> content "" again; the seat ignored the flag
//   max_tokens=3000                     -> full checklist
// So the cure is the ceiling, not the flag. max_tokens is a ceiling, not a spend.
import { describe, it, expect, beforeAll } from "vitest";

let executor;
const FLOOR = 4096;

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
  it("raises a starved ceiling to the floor", () => {
    const out = run("deepseek", "deepseek-v4.1-flash", { max_tokens: 700 });
    expect(out.max_tokens).toBe(FLOOR);
  });

  it("raises the ceiling even when the model claims thinking can be disabled", () => {
    // the claim is not a contract: one live seat ignored thinking:{type:"disabled"}
    // and still returned content "" at max_tokens=700
    const out = run("deepseek", "deepseek-v4.1-flash", { max_tokens: 700 });
    expect(out.max_tokens).toBe(FLOOR);
    expect(out.thinking?.type).toBe("disabled"); // free hint, nothing depends on it
  });

  it("raises the ceiling for a model that cannot disable thinking", () => {
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

  it("never overrides a client asking for thinking", () => {
    const out = run("deepseek", "deepseek-v4.1-flash", { max_tokens: 700, thinking: { type: "enabled" } });
    expect(out.thinking?.type).toBe("enabled");
    expect(out.max_tokens).toBe(FLOOR);
  });

  it("raises 2048 too — that cap was measured empty (reasoning ate all of it)", () => {
    const out = run("nvidia", "moonshotai/kimi-k2.6", { max_tokens: 2048 });
    expect(out.max_tokens).toBe(FLOOR);
  });

  it("leaves a cap that already sits on the floor unchanged", () => {
    const out = run("nvidia", "moonshotai/kimi-k2.6", { max_tokens: 4096 });
    expect(out.max_tokens).toBe(4096);
  });
});
