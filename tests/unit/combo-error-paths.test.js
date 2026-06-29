// Verify that combo strategies preserve X-VansRoute-Selected-Connection-Id
// headers from underlying model calls and degrade gracefully on total failure.
import { describe, it, expect, vi } from "vitest";
import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function okResponse(content, connectionId) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (connectionId) headers.set("X-VansRoute-Selected-Connection-Id", connectionId);
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers }
  );
}

function errResponse(status, message, connectionId) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (connectionId) headers.set("X-VansRoute-Selected-Connection-Id", connectionId);
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers }
  );
}

describe("combo fallback header propagation", () => {
  it("returns the selected-connection header of the succeeding model", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "openai/gpt-4o") return errResponse(429, "rate limit exceeded", "conn-failed");
      return okResponse("hello from gemini", "conn-gemini-ok");
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "gemini/gemini-1.5-flash"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("X-VansRoute-Selected-Connection-Id")).toBe("conn-gemini-ok");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("does not add a connection header when all models fail", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(503, "overloaded"));

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "gemini/gemini-1.5-flash"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.headers.get("X-VansRoute-Selected-Connection-Id")).toBeNull();
  });

  it("preserves the header through a daily-quota 429 fallback", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "openai/gpt-4o") {
        return errResponse(429, "today's quota exhausted", "conn-daily-quota");
      }
      return okResponse("hello", "conn-backup");
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "anthropic/claude-3-haiku"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("X-VansRoute-Selected-Connection-Id")).toBe("conn-backup");
  });
});

describe("fusion combo header propagation", () => {
  it("returns the judge's selected-connection header when panel succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return okResponse("final answer", "conn-judge");
      return okResponse(`panel answer from ${model}`, `conn-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      comboName: "test-fusion",
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("X-VansRoute-Selected-Connection-Id")).toBe("conn-judge");
  });

  it("returns the lone survivor's header when only one panel succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("lone survivor", "conn-lone");
      if (model === "p/judge") return okResponse("should not be called", "conn-judge");
      return errResponse(500, "failed");
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      comboName: "test-fusion",
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("X-VansRoute-Selected-Connection-Id")).toBe("conn-lone");
    expect(handleSingleModel.mock.calls.some(([, m]) => m === "p/judge")).toBe(false);
  });

  it("does not add a connection header when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(503, "overloaded"));

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      comboName: "test-fusion",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.headers.get("X-VansRoute-Selected-Connection-Id")).toBeNull();
  });
});
