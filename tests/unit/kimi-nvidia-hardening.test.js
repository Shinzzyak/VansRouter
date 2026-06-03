import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Kimi NVIDIA hardening", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("flags repetition_detected as tool-call failure when tools were requested", async () => {
    const mod = await import("../../open-sse/executors/default.js");
    expect(mod.__testing.isKimiToolFailure({
      stopReason: "repetition_detected",
      content: "plain text",
      expectsToolCalls: true,
    })).toBe(true);
  });

  it("does not flag repetition_detected when request had no tools", async () => {
    const mod = await import("../../open-sse/executors/default.js");
    expect(mod.__testing.isKimiToolFailure({
      stopReason: "repetition_detected",
      content: "plain text",
      expectsToolCalls: false,
    })).toBe(false);
  });

  it("flags long unstructured plain text as tool-call failure in tool mode", async () => {
    const mod = await import("../../open-sse/executors/default.js");
    const longText = "x".repeat(240);
    expect(mod.__testing.isKimiToolFailure({
      stopReason: "stop",
      content: longText,
      expectsToolCalls: true,
    })).toBe(true);
  });

  it("does not flag structured Kimi tool blocks", async () => {
    const mod = await import("../../open-sse/executors/default.js");
    const content = '<invoke name="functions.bash"><parameter name="cmd">pwd</parameter></invoke>';
    expect(mod.__testing.isKimiToolFailure({
      stopReason: "stop",
      content,
      expectsToolCalls: true,
    })).toBe(false);
  });

  it("detects tool expectations from request body", async () => {
    const mod = await import("../../open-sse/executors/default.js");
    expect(mod.__testing.requestExpectsToolCalls({
      tools: [{ type: "function", function: { name: "bash" } }],
      tool_choice: "auto",
    })).toBe(true);
    expect(mod.__testing.requestExpectsToolCalls({
      tools: [{ type: "function", function: { name: "bash" } }],
      tool_choice: "none",
    })).toBe(false);
  });

  it("throws on non-stream repetition_detected tool failure", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const executor = new DefaultExecutor("nvidia");
    const responsePayload = {
      choices: [{
        message: { role: "assistant", content: "x".repeat(260) },
        finish_reason: "repetition",
        stop_reason: "repetition_detected",
      }],
    };

    vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({
      response: new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: "https://example.test",
      headers: {},
      transformedBody: {},
    });

    await expect(executor.execute({
      model: "nvidia/moonshotai/kimi-k2.6",
      body: {
        messages: [{ role: "user", content: "call tool" }],
        tools: [{ type: "function", function: { name: "bash" } }],
        tool_choice: "auto",
      },
      stream: false,
      credentials: { apiKey: "k" },
      signal: undefined,
      log: undefined,
      proxyOptions: null,
    })).rejects.toThrow(/Kimi tool-call failure/i);
  });
});
