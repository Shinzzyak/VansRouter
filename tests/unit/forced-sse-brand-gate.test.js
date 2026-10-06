import { describe, it, expect } from "vitest";
import { handleForcedSSEToJson } from "open-sse/handlers/chatCore/sseToJsonHandler.js";
import { BRAND_LINE, SEAL_LINE } from "open-sse/rtk/brandContract.js";

// K43 — the brand/seal repair lives at exactly ONE call site
// (nonStreamingHandler.js). Providers flagged `forceStream: true` (codebuddy-intl,
// codebuddy-cn, codex, cline, agentrouter, autoclaw, commandcode, grok-cli, …)
// never reach it: a non-streaming client request is streamed upstream and then
// re-assembled by handleForcedSSEToJson, which returns the aggregated text as-is.
// Measured on the wire: 10/10 brand-bearing bodies from codebuddy-intl carried NO
// seal; 7/7 from a non-forceStream provider carried it. A body truncated by
// finish_reason=length keeps the brand line the model already wrote and never gets
// the seal appended — the client silently receives a contract-violating reply.
//
// These tests fail RED until the forced-SSE→JSON path applies the same repair.

const BODY = `${BRAND_LINE}\n\n`; // model wrote the brand line, cap ran out before the seal

function sseResponse(content, finishReason = "length") {
  const frames = [
    { id: "x", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { id: "x", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { id: "x", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 3, completion_tokens: 16, total_tokens: 19 } },
  ];
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function run(content, opts = {}) {
  const result = await handleForcedSSEToJson({
    providerResponse: sseResponse(content, opts.finishReason),
    provider: "codebuddy-intl",
    model: "deepseek-v4.1-flash",
    sourceFormat: "openai",
    targetFormat: "openai",
    providerResponseFormat: "openai",
    body: { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "sk-test",
    apiKeyInfo: null,
    apiKeyName: null,
    clientModelId: null,
    clientRawRequest: { endpoint: "/v1/messages", headers: { "content-type": "application/json" } },
    onRequestSuccess: () => {},
    reqLogger: { logProviderResponse: () => {}, logConvertedResponse: () => {} },
    toolNameMap: null,
    trackDone: () => {},
    appendLog: () => {},
    pxpipe: null,
    comboName: null,
  });
  const resp = result?.response ?? result;
  if (resp && typeof resp.json === "function") return await resp.json();
  if (resp && typeof resp.text === "function") return JSON.parse(await resp.text());
  return resp;
}

const contentOf = (res) => res?.choices?.[0]?.message?.content ?? "";

describe("K43 forced-SSE→JSON brand gate", () => {
  it("appends the missing seal when the aggregated body is truncated", async () => {
    const content = contentOf(await run(BODY));
    expect(content.split("\n")[0].trim()).toBe(BRAND_LINE);
    expect(content.trimEnd().endsWith(SEAL_LINE)).toBe(true);
  });

  it("does not duplicate the seal when the body is already compliant", async () => {
    const content = contentOf(await run(`${BRAND_LINE}\n\nmph. shipped.\n\n${SEAL_LINE}`));
    expect(content.trimEnd().endsWith(SEAL_LINE)).toBe(true);
    expect(content.split(SEAL_LINE).length - 1).toBe(1);
  });
});
