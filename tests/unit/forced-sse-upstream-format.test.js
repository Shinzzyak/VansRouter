import { describe, it, expect } from "vitest";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// A provider can declare format:"openai" and still serve SOME models from a
// Responses endpoint. opencode is exactly that case: muse-spark-* goes to
// /zen/v1/responses, every other model to /zen/v1/chat/completions.
//
// The forced-SSE→JSON path used to pick its branch from the CLIENT's format, so
// a non-streaming muse-spark request was parsed as Chat Completions: the
// Responses envelope has no choices[], the parser found nothing, and the client
// got 200 with content "". Passing providerResponseFormat routes it correctly.
//
// Fixture is the real upstream envelope (captured 2026-09-22), trimmed: the
// output_item.done / content_part.done events are what the converter reads.

const RESPONSES_SSE = [
  'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","model":"muse-spark-1.2-contributor-free","output":[]}}',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}',
  'event: response.content_part.added\ndata: {"type":"response.content_part.added","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"HELLO-RESPONSES"}',
  'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":4,"item_id":"msg_1","output_index":0,"content_index":0,"text":"HELLO-RESPONSES"}',
  'event: response.content_part.done\ndata: {"type":"response.content_part.done","sequence_number":5,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"HELLO-RESPONSES","annotations":[]}}',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"HELLO-RESPONSES","annotations":[]}]}}',
  'event: response.completed\ndata: {"type":"response.completed","sequence_number":7,"response":{"id":"resp_1","object":"response","status":"completed","model":"muse-spark-1.2-contributor-free","output":[{"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"HELLO-RESPONSES","annotations":[]}]}],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
  "",
].join("\n\n"); // SSE events are blank-line separated; a single \n merges them into one

const CHAT_SSE = [
  'data: {"id":"g1","object":"chat.completion.chunk","created":1,"model":"mimo-v2.5-free","choices":[{"index":0,"finish_reason":null,"delta":{"role":"assistant","content":"WORLD"}}]}',
  'data: {"id":"g1","object":"chat.completion.chunk","created":1,"model":"mimo-v2.5-free","choices":[{"index":0,"finish_reason":"stop","delta":{}}]}',
  "data: [DONE]",
  "",
].join("\n");

const sseResponse = (text) => new Response(text, { headers: { "content-type": "text/event-stream" } });

async function run(sse, providerResponseFormat) {
  const result = await handleForcedSSEToJson({
    providerResponse: sseResponse(sse),
    sourceFormat: FORMATS.OPENAI,
    provider: "opencode",
    model: "muse-spark-1.2-contributor-free",
    body: { messages: [], tools: [] },
    stream: false,
    providerResponseFormat,
    trackDone: () => {},
    appendLog: () => {},
  });
  if (!result?.success) return null;
  const json = JSON.parse(await result.response.text());
  return json.choices?.[0]?.message?.content ?? null;
}

describe("handleForcedSSEToJson — upstream format routing", () => {
  it("parses a Responses SSE envelope when providerResponseFormat says so", async () => {
    expect(await run(RESPONSES_SSE, FORMATS.OPENAI_RESPONSES)).toBe("HELLO-RESPONSES");
  });

  it("returns empty content when the Responses envelope is parsed as Chat (the bug)", async () => {
    // Documents the regression this guards: no providerResponseFormat -> wrong
    // branch -> no choices[] -> empty content with a 200.
    expect(await run(RESPONSES_SSE, undefined)).toBe("");
  });

  it("still parses a Chat Completions SSE stream", async () => {
    expect(await run(CHAT_SSE, FORMATS.OPENAI)).toBe("WORLD");
  });

  it("does not mis-route a Chat stream that claims to be Responses", async () => {
    // Wrong branch on a Chat payload yields no content either — proves the flag
    // is load-bearing in both directions, not just a no-op.
    expect(await run(CHAT_SSE, FORMATS.OPENAI_RESPONSES)).toBe("");
  });
});
