/**
 * A Kiro turn that dies upstream is reported by the executor as an SSE error
 * frame: `data: {"error":{"message":...,"type":"upstream_error","code":...}}`.
 * The response translators used to drop that frame (no choices[0] -> return null),
 * so the client received HTTP 200 with heartbeats and [DONE] but no delta and no
 * finish_reason — an "empty stream" that hides a real upstream failure.
 *
 * These tests lock the frame to a visible terminal error.
 */
import { describe, expect, it } from "vitest";

// Resolve the mixed-case vendor identifier through the module namespace instead
// of naming it literally: a rebranding filter on this pipeline rewrites that
// token, and a corrupted import name is a collection-time SyntaxError.
const kiroOpenai = await import("../../open-sse/translator/response/kiro-to-openai.js");
const kiroClaude = await import("../../open-sse/translator/response/kiro-to-claude.js");
const { hasValuableContent } = await import("../../open-sse/utils/streamHelpers.js");

const toChunk = kiroOpenai[Object.keys(kiroOpenai).find((k) => /^kiroTo.*Response$/.test(k))];
const toClaude = kiroClaude[Object.keys(kiroClaude).find((k) => /^kiroTo.*Response$/.test(k))];

const ERROR_FRAME = {
  error: {
    message: "Kiro integrity validation failed after one bounded retry: no_semantic_output",
    type: "upstream_error",
    code: "kiro_missing_terminal_retry_failed"
  }
};

function freshState() {
  return { responseId: "chatcmpl-test", created: 1700000000, model: "kr/gpt-5.6-sol", chunkIndex: 0 };
}

describe("Kiro upstream error frame survives translation", () => {
  it("exposes both translators", () => {
    expect(typeof toChunk).toBe("function");
    expect(typeof toClaude).toBe("function");
  });

  it("maps an error frame to a terminal error chunk for chat-completions clients", () => {
    const state = freshState();
    const chunk = toChunk(ERROR_FRAME, state);

    expect(chunk).not.toBeNull();
    expect(chunk.choices[0].finish_reason).toBe("error");
    expect(chunk.error.code).toBe("kiro_missing_terminal_retry_failed");
    expect(chunk.error.message).toContain("bounded retry");
    expect(state.finishReason).toBe("error");
  });

  it("parses the executor's raw SSE error line", () => {
    const state = freshState();
    const raw = `data: ${JSON.stringify(ERROR_FRAME)}`;
    const chunk = toChunk(raw, state);

    expect(chunk?.choices[0].finish_reason).toBe("error");
    expect(chunk?.error.code).toBe("kiro_missing_terminal_retry_failed");
  });

  it("survives the stream filter so it is never dropped as an empty chunk", () => {
    const chunk = toChunk(ERROR_FRAME, freshState());
    expect(hasValuableContent(chunk, "openai")).toBeTruthy();
  });

  it("maps an error frame to a Claude error event", () => {
    const events = toClaude(ERROR_FRAME, {});
    expect(Array.isArray(events)).toBe(true);
    expect(events[0].type).toBe("error");
    expect(events[0].error.code).toBe("kiro_missing_terminal_retry_failed");
  });

  it("still ignores genuinely unknown frames", () => {
    expect(toChunk({ contextUsageEvent: { contextUsagePercentage: 12 } }, freshState())).toBeNull();
  });
});
