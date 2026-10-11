import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const enc = new TextEncoder();

/** Wrap raw SSE text in a closed stream, the shape the converter consumes. */
function streamOf(raw) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(raw));
      controller.close();
    }
  });
}

/** Drive handleForcedSSEToJson down the Responses-upstream branch. */
function runHandler(raw, overrides = {}) {
  return handleForcedSSEToJson({
    providerResponse: new Response(streamOf(raw), { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.OPENAI,
    provider: "codex",
    model: "gpt-5.6-terra",
    body: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    ...overrides
  });
}

const FAILED_EVENT = [
  'event: response.created\ndata: {"response":{"id":"resp_x","created_at":1}}',
  'event: response.failed\ndata: {"response":{"id":"resp_x","status":"failed","error":{"code":"content_filter","message":"upstream guardrail blocked the request"}}}',
  ""
].join("\n\n");

describe("Responses stream → JSON keeps the failure detail", () => {
  it("carries status=failed and the upstream error payload instead of dropping it", async () => {
    const out = await convertResponsesStreamToJson(streamOf(FAILED_EVENT));

    expect(out.status).toBe("failed");
    expect(out.error).toEqual({
      code: "content_filter",
      message: "upstream guardrail blocked the request"
    });
    expect(out.output).toEqual([]);
  });

  it("does not call a silent output-less stream 'completed'", async () => {
    // No response.completed, no items: the old default was the string "completed".
    const out = await convertResponsesStreamToJson(streamOf('event: response.created\ndata: {"response":{"id":"resp_y"}}\n\n'));

    expect(out.status).toBe("incomplete");
  });

  it("still reports completed when the upstream said so and output arrived", async () => {
    const raw = [
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}',
      'event: response.completed\ndata: {"response":{"id":"resp_z","status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}',
      ""
    ].join("\n\n");
    const out = await convertResponsesStreamToJson(streamOf(raw));

    expect(out.status).toBe("completed");
    expect(out.error).toBeUndefined();
  });
});

describe("failed Responses upstream is not a silent 200", () => {
  it("returns 502 with the upstream reason instead of an empty success", async () => {
    const result = await runHandler(FAILED_EVENT);
    const json = await result.response.json();

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(json.error.message).toContain("upstream guardrail blocked the request");
    expect(json).not.toHaveProperty("choices");
  });

  it("keeps a completed text answer on the success path", async () => {
    const raw = [
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"PONG"}]}}',
      'event: response.completed\ndata: {"response":{"id":"resp_ok","status":"completed","usage":{"input_tokens":4,"output_tokens":1}}}',
      ""
    ].join("\n\n");
    const result = await runHandler(raw);
    const json = await result.response.json();

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(json.choices[0].message.content).toContain("PONG");
  });

  it("does not treat a tool-call-only turn as a failure", async () => {
    const raw = [
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"function_call","name":"Bash","call_id":"c1","arguments":"{}"}}',
      'event: response.failed\ndata: {"response":{"id":"resp_t","status":"failed"}}',
      ""
    ].join("\n\n");
    const result = await runHandler(raw);
    const json = await result.response.json();

    // The tool payload IS the output; a failure status must not erase it.
    expect(result.success).toBe(true);
    expect(json.choices[0].message.tool_calls?.[0]?.function?.name).toBe("Bash");
  });
});
