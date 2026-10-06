/**
 * K42 follow-up — the empty reason must reach the CLIENT, not only the ledger.
 *
 * The ledger records `empty_reason` per request, so the router can explain itself
 * after the fact. The buyer's HTTP client never reads the ledger: an empty 200
 * with no visible text and no reason attached is indistinguishable from a broken
 * router. This gate asserts the reason is also emitted as a response header on the
 * non-streaming path, and that the reason is computed by the SAME helper the
 * ledger reads (one definition, not two — see emptyReason.js).
 *
 * Why not the streaming path: headers are flushed before the first byte, and the
 * reason is only known once the stream ends. There is no honest header to add
 * there; the ledger is the only surface. Asserted below so nobody "completes" the
 * parity by adding a header that can never carry a value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { emptyReasonFor, emptyReasonHeaders, emptyReasonHeadersFor } from "../../open-sse/handlers/chatCore/emptyReason.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, "..", "..", rel), "utf8");

describe("emptyReasonHeaders — the reason on the wire (K42)", () => {
  it("emits no header when there IS visible text", () => {
    const reason = emptyReasonFor({ content: "hello", sawToolCalls: false, finishReason: "stop" });
    expect(reason).toBe(null);
    expect(emptyReasonHeaders(reason)).toEqual({});
  });

  it("emits the reason as a header when the reply is empty", () => {
    const reason = emptyReasonFor({ content: "", sawToolCalls: false, finishReason: "length" });
    expect(reason).toBe("no_text:length");
    expect(emptyReasonHeaders(reason)).toEqual({ "x-vansrouter-empty-reason": "no_text:length" });
  });

  it("tells a tool-call turn apart from a burnt cap", () => {
    const tool = emptyReasonHeaders(
      emptyReasonFor({ content: "", sawToolCalls: true, finishReason: "tool_calls" })
    );
    const burnt = emptyReasonHeaders(
      emptyReasonFor({ content: "", sawToolCalls: false, finishReason: "length" })
    );
    expect(tool["x-vansrouter-empty-reason"]).toBe("tool_calls");
    expect(burnt["x-vansrouter-empty-reason"]).toBe("no_text:length");
    expect(tool).not.toEqual(burnt);
  });

  it("header name is lowercase — HTTP/2 lowercases it anyway, and the buyer greps for one spelling", () => {
    const keys = Object.keys(emptyReasonHeaders("no_text:length"));
    expect(keys).toEqual(["x-vansrouter-empty-reason"]);
  });
});

describe("both handlers read ONE definition of the reason (K42)", () => {
  it("non-streaming handler spreads the header helper into its Response headers", () => {
    const src = read("open-sse/handlers/chatCore/nonStreamingHandler.js");
    expect(src).toMatch(/emptyReasonHeaders\(emptyReason\)/);
    expect(src).toMatch(/const emptyReason = emptyReasonFor\(\{/);
  });

  it("non-streaming handler computes the reason ONCE and reuses it for ledger + header", () => {
    const src = read("open-sse/handlers/chatCore/nonStreamingHandler.js");
    // Exactly one call site: a second call is how two copies drift (2026-09-22).
    const calls = src.match(/emptyReasonFor\(\{/g) || [];
    expect(calls.length).toBe(1);
  });

  it("streaming handler keeps the reason in the ledger, and adds NO header", () => {
    const src = read("open-sse/handlers/chatCore/streamingHandler.js");
    expect(src).toMatch(/const emptyReason = emptyReasonFor\(\{/);
    // Headers are flushed before the stream ends, so the reason cannot ride one.
    expect(src).not.toMatch(/emptyReasonHeaders/);
  });
});

describe("emptyReasonHeadersFor — count-shaped callers (K42)", () => {
  it("no header when text is present, header when it is not", () => {
    expect(emptyReasonHeadersFor({ content: "hi", toolCalls: 0, finishReason: "stop" })).toEqual({});
    expect(emptyReasonHeadersFor({ content: "", toolCalls: 0, finishReason: "length" }))
      .toEqual({ "x-vansrouter-empty-reason": "no_text:length" });
  });

  it("a tool-call count reads as tool_calls, not as a burnt cap", () => {
    expect(emptyReasonHeadersFor({ content: "", toolCalls: 2, finishReason: "tool_calls" }))
      .toEqual({ "x-vansrouter-empty-reason": "tool_calls" });
  });
});

describe("the reason actually reaches the client (K42, wire-level)", () => {
  // Not a source grep: the handler is CALLED and the header is read off the real
  // Response. Fixture is a real cap-truncated shape — finish_reason `length`, no text.
  const EMPTY_SSE = [
    'data: {"id":"g1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"finish_reason":null,"delta":{"role":"assistant","content":""}}]}',
    'data: {"id":"g1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"finish_reason":"length","delta":{}}]}',
    "data: [DONE]",
    "",
  ].join("\n");

  it("forced-SSE→JSON exit: empty body + finish_reason=length → header says no_text:length", async () => {
    const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
    const { FORMATS } = await import("../../open-sse/translator/formats.js");
    const r = await handleForcedSSEToJson({
      providerResponse: new Response(EMPTY_SSE, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI, provider: "codebuddy-intl", model: "m",
      body: { messages: [], tools: [] }, stream: false,
      trackDone: () => {}, appendLog: () => {},
    });
    expect(r?.success).toBe(true);
    const body = JSON.parse(await r.response.text());
    expect(body.choices[0].message.content).toBe("");
    expect(body.choices[0].finish_reason).toBe("length");
    expect(r.response.headers.get("x-vansrouter-empty-reason")).toBe("no_text:length");
  });
});

describe("EVERY non-streaming JSON exit carries the reason (K42 + the K43 lesson)", () => {
  const files = [
    "open-sse/handlers/chatCore/nonStreamingHandler.js",
    "open-sse/handlers/chatCore/sseToJsonHandler.js",
  ];

  for (const f of files) {
    it(`${f}: one header-spread per Response construction`, () => {
      const src = read(f);
      const responses = src.match(/new Response\(/g) || [];
      const spreads = src.match(/\.\.\.emptyReasonHeaders(For)?\(/g) || [];
      expect(responses.length).toBeGreaterThan(0);
      // Equal counts is the whole gate: a NEW exit added without the spread goes red
      // here. This is the check that would have caught K43 (repair in 1 of 2 paths).
      expect(spreads.length).toBe(responses.length);
    });
  }
});
