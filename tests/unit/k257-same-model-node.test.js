// K257 — a refusal names a NODE, not a model.
//
// Owner's report, 2026-10-28: two providers can serve the SAME model and disagree —
// one answers, the other refuses. If the router reads "the model refused" as a fact
// about the model, it rotates to a different model (or a different family) when the
// real fix was the same model on the other node, whose own injected system prompt is
// the wall.
//
// This arm tests the routing consequence: after a content refusal, the next
// same-model node is pulled forward ONE slot. Nothing already tried is retried, the
// rest of the rotation keeps its order, and with no such node the order is untouched.
import { describe, it, expect, beforeEach } from "vitest";
import { handleComboChat, resetComboRotation } from "open-sse/services/combo.js";

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const REFUSAL = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "I can't help with that request." } }],
});
const ANSWER = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "Here is the function you asked for." } }],
});

const res = (body) => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

async function run(candidates) {
  const tried = [];
  const out = await handleComboChat({
    body: { messages: [{ role: "user", content: "Ping" }], stream: false },
    models: Object.keys(candidates),
    handleSingleModel: async (_body, modelStr) => {
      tried.push(modelStr);
      return candidates[modelStr];
    },
    log: quietLog,
    comboName: `k257-${Math.random().toString(36).slice(2)}`,
    comboStrategy: "fallback",
    timeoutMs: 0,
  });
  const resp = typeof out?.text === "function" ? out : out?.response;
  const text = typeof resp?.text === "function" ? await resp.text() : "";
  return { tried, status: resp?.status, text };
}

beforeEach(() => resetComboRotation());

describe("K257: same model on another node goes before a different model", () => {
  it("bubbles the twin node forward after a refusal", async () => {
    const { tried, status, text } = await run({
      "alpha/deepseek-v4.1-flash": res(REFUSAL),
      "omega/other-model": res(ANSWER),
      "beta/deepseek-v4.1-flash": res(ANSWER),
    });
    // omega sits earlier in the list but is a DIFFERENT model: the twin node wins.
    expect(tried).toEqual(["alpha/deepseek-v4.1-flash", "beta/deepseek-v4.1-flash"]);
    expect(status).toBe(200);
    expect(text).toContain("Here is the function");
  });

  it("leaves the order alone when no other node serves the model", async () => {
    const { tried } = await run({
      "alpha/deepseek-v4.1-flash": res(REFUSAL),
      "omega/other-model": res(ANSWER),
    });
    expect(tried).toEqual(["alpha/deepseek-v4.1-flash", "omega/other-model"]);
  });

  it("does not retry the node that already refused", async () => {
    const { tried } = await run({
      "alpha/deepseek-v4.1-flash": res(REFUSAL),
      "beta/deepseek-v4.1-flash": res(ANSWER),
      "alpha/deepseek-v4.1-flash": res(ANSWER), // duplicate key can't exist in JS — kept out
    });
    expect(tried.filter((m) => m === "alpha/deepseek-v4.1-flash")).toHaveLength(1);
  });

  it("the tail of the rotation keeps its order after the bubble", async () => {
    const { tried } = await run({
      "alpha/deepseek-v4.1-flash": res(REFUSAL),
      "gamma/third-model": res(ANSWER),
      "delta/fourth-model": res(ANSWER),
      "beta/deepseek-v4.1-flash": res(ANSWER),
    });
    expect(tried).toEqual(["alpha/deepseek-v4.1-flash", "beta/deepseek-v4.1-flash"]);
  });
});
