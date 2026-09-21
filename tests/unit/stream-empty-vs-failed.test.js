// Regression test for the "[Empty streaming response]" reporting bug.
//
// A tool-call-only or reasoning-only turn is a NORMAL agent turn that SUCCEEDED:
// the client receives a full tool_calls payload, and delta.content is legitimately
// empty. createSSEStream only ever forwarded `content` + `thinking` to
// onStreamComplete, and buildOnStreamComplete stored `content || "[Empty streaming
// response]"` with no finish_reason and no tool-call indicator. So a healthy
// tool-call turn and a genuinely dead stream produced byte-identical records.
//
// Measured live before the fix: 571 of 1000 rows in requestDetails read
// "[Empty streaming response]" with status "success", indistinguishable from a
// broken stream. Reproduced on demand with a forced get_weather tool call
// (finish_reason: "tool_calls", 10 tool-call chunks, content_chars 0).
//
// The fix adds two signals (finishReason, sawToolCalls) and records them. It must
// NOT change the bytes sent to the client, the `status` value, or the string that
// the stream-integrity classifier sees — those are asserted below as invariants.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const saved = [];
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async (detail) => { saved.push(detail); }),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(() => {}),
}));

const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");

const enc = new TextEncoder();
const sseChunk = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

async function runStream(chunks, { mode = "passthrough", body } = {}) {
  let payload = null;
  let usage = null;

  const stream = createSSEStream({
    mode,
    ...(mode === "translate" ? { targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI } : {}),
    provider: "openai-compatible-chat-test",
    model: "test-model",
    connectionId: "conn-test",
    body: body || { model: "test-model", messages: [{ role: "user", content: "x" }] },
    onStreamComplete: (content, u) => { payload = content; usage = u; },
  });

  const readable = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const reader = readable.pipeThrough(stream).getReader();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(new TextDecoder().decode(value));
  }
  return { payload, usage, wire: out.join("") };
}

const toolCallChunk = sseChunk({
  id: "chatcmpl-1",
  choices: [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: "call_1", type: "function",
      function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }] },
  }],
});
const toolCallFinish = sseChunk({
  id: "chatcmpl-1",
  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 900, completion_tokens: 42, total_tokens: 942 },
});
const textChunk = sseChunk({
  id: "chatcmpl-2",
  choices: [{ index: 0, delta: { content: "A normal visible reply." } }],
});
const textFinish = sseChunk({
  id: "chatcmpl-2",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
});
const reasoningChunk = sseChunk({
  id: "chatcmpl-3",
  choices: [{ index: 0, delta: { reasoning_content: "thinking hard..." } }],
});
const reasoningFinish = sseChunk({
  id: "chatcmpl-3",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
});

describe("createSSEStream — empty-vs-failed signals", () => {
  it("tool-call-only passthrough reports sawToolCalls + finishReason tool_calls", async () => {
    const { payload } = await runStream([toolCallChunk, toolCallFinish]);
    expect(payload.content).toBe("");
    expect(payload.sawToolCalls).toBe(true);
    expect(payload.finishReason).toBe("tool_calls");
  });

  it("normal text passthrough still reports content, no tool calls", async () => {
    const { payload } = await runStream([textChunk, textFinish]);
    expect(payload.content).toBe("A normal visible reply.");
    expect(payload.sawToolCalls).toBe(false);
    expect(payload.finishReason).toBe("stop");
  });

  it("a genuinely dead stream reports NO tool calls and NO finish reason", async () => {
    const { payload } = await runStream([]);
    expect(payload.content).toBe("");
    expect(payload.sawToolCalls).toBe(false);
    expect(payload.finishReason).toBeNull();
  });

  it("reasoning-only turn keeps thinking and is distinguishable from tool calls", async () => {
    const { payload } = await runStream([reasoningChunk, reasoningFinish]);
    expect(payload.content).toBe("");
    expect(payload.thinking).toBe("thinking hard...");
    expect(payload.sawToolCalls).toBe(false);
    expect(payload.finishReason).toBe("stop");
  });

  it("translate mode also reports tool calls (the signal is not passthrough-only)", async () => {
    const { payload } = await runStream([toolCallChunk, toolCallFinish], { mode: "translate" });
    expect(payload.sawToolCalls).toBe(true);
    expect(payload.finishReason).toBe("tool_calls");
  });

  it("INVARIANT: an empty tool_calls array must not count as a tool call", async () => {
    // CodeBuddy CN ships `tool_calls: []` on every delta; that is not a tool call.
    const emptyToolCalls = sseChunk({
      id: "chatcmpl-4",
      choices: [{ index: 0, delta: { tool_calls: [] } }],
    });
    const { payload } = await runStream([emptyToolCalls, textChunk, textFinish]);
    expect(payload.sawToolCalls).toBe(false);
    expect(payload.content).toBe("A normal visible reply.");
  });
});

describe("buildOnStreamComplete — empty_reason disambiguation", () => {
  beforeEach(() => { saved.length = 0; });

  function record(payload) {
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "test-provider", model: "test-model", connectionId: "conn-test",
      apiKey: null, apiKeyInfo: null, apiKeyName: null,
      requestStartTime: Date.now(), body: { messages: [] }, stream: true,
      finalBody: null, translatedBody: null, clientRawRequest: { endpoint: "/v1/chat/completions" },
      pxpipe: null,
    });
    onStreamComplete(payload, { prompt_tokens: 1, completion_tokens: 1 }, Date.now());
    return saved.at(-1);
  }

  it("tool-call-only turn is labelled tool_calls, not empty", () => {
    const d = record({ content: "", thinking: null, finishReason: "tool_calls", sawToolCalls: true });
    expect(d.response.empty_reason).toBe("tool_calls");
    expect(d.response.finish_reason).toBe("tool_calls");
    expect(d.response.tool_calls).toBe(true);
  });

  it("a dead stream is NOT labelled tool_calls — this is the distinction that was missing", () => {
    const d = record({ content: "", thinking: null, finishReason: null, sawToolCalls: false });
    expect(d.response.empty_reason).toBe("no_text");
    expect(d.response.finish_reason).toBeNull();
    expect(d.response.tool_calls).toBe(false);
  });

  it("reasoning-only turn is labelled with its finish reason", () => {
    const d = record({ content: "", thinking: "why", finishReason: "stop", sawToolCalls: false });
    expect(d.response.empty_reason).toBe("no_text:stop");
  });

  it("a turn with visible text has no empty_reason", () => {
    const d = record({ content: "hello", thinking: null, finishReason: "stop", sawToolCalls: false });
    expect(d.response.empty_reason).toBeNull();
    expect(d.response.content).toBe("hello");
  });

  it("INVARIANT: content/providerResponse keep the exact pre-fix values", () => {
    // The stream-integrity classifier reads this string. Changing it would change
    // refusal detection and the self-measuring bypass ledger, so it must not move.
    const empty = record({ content: "", thinking: null, finishReason: null, sawToolCalls: false });
    expect(empty.response.content).toBe("[Empty streaming response]");
    expect(empty.providerResponse).toBe("[Empty streaming response]");
    expect(empty.status).toBe("success");

    const full = record({ content: "real text", thinking: "t", finishReason: "stop", sawToolCalls: false });
    expect(full.response.content).toBe("real text");
    expect(full.providerResponse).toBe("real text");
    expect(full.status).toBe("success");
  });

  it("INVARIANT: a payload without the new fields behaves exactly as before", () => {
    // Callers other than createSSEStream (if any) pass the old two-field shape.
    const d = record({ content: "", thinking: null });
    expect(d.response.content).toBe("[Empty streaming response]");
    expect(d.response.finish_reason).toBeNull();
    expect(d.response.tool_calls).toBe(false);
    expect(d.response.empty_reason).toBe("no_text");
  });
});

// The seam. The unit tests above pass plain objects into buildOnStreamComplete,
// which proves the labelling logic but NOT that createSSEStream actually hands
// those fields over. This one wires the real stream into the real callback: if
// the shape ever drifts apart, the label silently reverts to "no_text" and every
// tool-call turn goes back to looking like a dead stream.
describe("SEAM — createSSEStream feeds buildOnStreamComplete", () => {
  it("a real tool-call-only stream lands in the record labelled tool_calls", async () => {
    let saved = null;
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "test-provider", model: "test-model", connectionId: "conn-seam",
      apiKey: "sk-test", apiKeyName: "seam", requestStartTime: Date.now(),
      body: { model: "test-model", messages: [{ role: "user", content: "x" }] },
      stream: true, finalBody: null, translatedBody: null, clientRawRequest: null,
    });
    // Capture instead of writing to the DB.
    const { saveRequestDetail } = await import("@/lib/usageDb.js");
    // Must return a promise: the real caller does `saveRequestDetail(...).catch()`.
    saveRequestDetail.mockImplementation((d) => { saved = d; return Promise.resolve(); });

    const chunks = [
      sseChunk({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"/a\"}" } },
      ] } }] }),
      sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                 usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ];

    const stream = createSSEStream({
      mode: "passthrough", provider: "test-provider", model: "test-model",
      connectionId: "conn-seam",
      body: { model: "test-model", messages: [{ role: "user", content: "x" }] },
      onStreamComplete,
    });
    const readable = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const reader = readable.pipeThrough(stream).getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }

    expect(saved).not.toBeNull();
    expect(saved.response.tool_calls).toBe(true);
    expect(saved.response.finish_reason).toBe("tool_calls");
    expect(saved.response.empty_reason).toBe("tool_calls");
    expect(saved.response.content).toBe("[Empty streaming response]"); // unchanged
  });
});
