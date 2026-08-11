import { describe, it, expect, vi } from "vitest";

import { handleThinkExecuteChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat Response stub with the .ok + .clone().json() surface the engine uses.
function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  const res = make();
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : res;
}

function errResponse(status = 500) {
  const make = () => ({ ok: false, status, clone: make, json: async () => ({ error: { message: "boom" } }) });
  return make();
}

describe("think-execute combo", () => {
  it("runs thinking pass then execution pass with injected analysis", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      seen.push({ model, isPanel, stream: body.stream, hasTools: !!body.tools, msgCount: body.messages.length });
      if (model === "p/thinker") return okResponse("analysis: the answer is 42");
      return okResponse("FINAL ANSWER");
    });

    const res = await handleThinkExecuteChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/thinker", "p/exec"],
      handleSingleModel,
      log,
      thinkingModel: "p/thinker",
      executionModel: "p/exec",
    });

    expect(res.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);

    // Thinking pass: non-streaming, tools stripped, isPanel=true.
    const thinkCall = seen[0];
    expect(thinkCall.model).toBe("p/thinker");
    expect(thinkCall.stream).toBe(false);
    expect(thinkCall.hasTools).toBe(false);
    expect(thinkCall.isPanel).toBe(true);

    // Execution pass: original stream flag preserved, tools preserved, analysis injected.
    const execCall = seen[1];
    expect(execCall.model).toBe("p/exec");
    expect(execCall.stream).toBe(true);
    expect(execCall.hasTools).toBe(true);
    expect(execCall.isPanel).toBeUndefined();
    // Original 1 message + 1 injected analysis turn.
    expect(execCall.msgCount).toBe(2);
    const execBody = handleSingleModel.mock.calls[1][0];
    expect(execBody.messages[1].content).toContain("analysis: the answer is 42");
  });

  it("defaults both roles to the first combo model", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ok"));
    await handleThinkExecuteChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/first");
    expect(handleSingleModel.mock.calls[1][1]).toBe("p/first");
  });

  it("degrades to plain execution when the thinker fails", async () => {
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "p/thinker") return errResponse(500);
      return okResponse("FINAL");
    });

    const res = await handleThinkExecuteChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/thinker", "p/exec"],
      handleSingleModel,
      log,
      thinkingModel: "p/thinker",
      executionModel: "p/exec",
    });

    expect(res.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    // No injected analysis turn — original body passed through untouched.
    const execBody = handleSingleModel.mock.calls[1][0];
    expect(execBody.messages.length).toBe(1);
  });

  it("degrades to plain execution when the thinker times out", async () => {
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "p/thinker") {
        // Simulate a hang: never resolves within the tiny timeout.
        return new Promise(() => {});
      }
      return okResponse("FINAL");
    });

    const res = await handleThinkExecuteChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/thinker", "p/exec"],
      handleSingleModel,
      log,
      thinkingModel: "p/thinker",
      executionModel: "p/exec",
      tuning: { thinkingTimeoutMs: 50 },
    });

    expect(res.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    const execBody = handleSingleModel.mock.calls[1][0];
    expect(execBody.messages.length).toBe(1);
  });
});
