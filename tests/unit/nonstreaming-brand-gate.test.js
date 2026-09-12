import { describe, it, expect } from "vitest";
import { handleNonStreamingResponse } from "open-sse/handlers/chatCore/nonStreamingHandler.js";
import { BRAND_LINE, SEAL_LINE } from "open-sse/rtk/brandContract.js";

// The brand/seal repair is a chat-surface behaviour. Traffic that opted out of
// router-side prompt massaging (x-9router-token-saver: off) is consumed by a
// validator — a delegation harness, a JSON-schema check — so appending the
// contract would corrupt the answer instead of fixing it. Both halves matter:
// without the gate, delegated work is destroyed; with the gate wrongly applied,
// the chat surface loses its attribution.

const BODY_TEXT = "mph. plain body, no contract.";

function upstream(content = BODY_TEXT) {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function run(headers) {
  const result = await handleNonStreamingResponse({
    providerResponse: upstream(),
    provider: "test-provider",
    model: "test-model",
    sourceFormat: "openai",
    targetFormat: "openai",
    body: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "k",
    apiKeyInfo: null,
    apiKeyName: null,
    clientModelId: null,
    clientRawRequest: { endpoint: "/v1/chat/completions", headers },
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

function contentOf(res) {
  const c = res?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

describe("non-streaming brand gate", () => {
  it("repairs the contract on the chat surface (no opt-out header)", async () => {
    const content = contentOf(await run({ "content-type": "application/json" }));
    expect(content.split("\n")[0]).toBe(BRAND_LINE);
    expect(content.trimEnd().endsWith(SEAL_LINE)).toBe(true);
  });

  it("leaves opted-out traffic untouched", async () => {
    const res = await run({ "x-9router-token-saver": "off" });
    console.log("DEBUG opted-out body:", JSON.stringify(res).slice(0, 400));
    const content = contentOf(res);
    expect(content).toBe(BODY_TEXT);
    expect(content.includes(BRAND_LINE)).toBe(false);
    expect(content.includes(SEAL_LINE)).toBe(false);
  });
});
