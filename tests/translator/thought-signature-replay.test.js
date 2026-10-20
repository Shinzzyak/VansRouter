// Thought-signature replay (upstream thoughtSignatureStore port).
//
// Why this exists: Gemini 3+ rejects a functionCall part that carries no thoughtSignature
// (400 "Corrupted thought signature"), and agent clients ([CC], IDE) drop the signature when
// they persist their own history. Upstream fixed it by caching the signature per tool-call id
// and replaying it on the next request. These tests pin the whole loop:
//
//   response part (signature) -> store -> request part (same signature, same call id)
//
// The negative controls matter as much as the happy path: a signature minted by a different
// model family must NOT be replayed, an unknown call id must still fall back to the default,
// and an expired entry must not resurrect.
import { describe, it, expect, beforeEach } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  storeGeminiThoughtSignature,
  getGeminiThoughtSignatureSync,
  __clearThoughtSignatures,
  __setSignatureExpiry,
} from "../../open-sse/services/thoughtSignatureStore.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

// Shaped like a real Gemini signature: long, opaque, definitely not the default constant.
const REAL_SIG = "CqQBAQj7s6PUBBKcAXNpZ25hdHVyZS1mcm9tLWdlbWluaS1iYWNrZW5kLXJlYWwtc2lnLTAwMQ==";
const CLAUDE_SIG = "Y2xhdWRlLWZhbWlseS1zaWduYXR1cmUtc2hvdWxkLW5vdC1yZXBsYXktdG8tZ2VtaW5p";

function geminiChunk(parts, modelVersion = "gemini-3.8-flash-low") {
  return {
    response: {
      candidates: [{ content: { parts }, finishReason: "STOP" }],
      modelVersion,
    },
  };
}

function collectToolCalls(chunks) {
  const out = [];
  for (const chunk of Array.isArray(chunks) ? chunks : [chunks]) {
    const delta = chunk?.choices?.[0]?.delta;
    if (delta?.tool_calls) out.push(...delta.tool_calls);
  }
  return out;
}

function functionCallParts(translated) {
  const out = [];
  for (const content of translated?.contents || []) {
    for (const part of content.parts || []) {
      if (part.functionCall) out.push(part);
    }
  }
  return out;
}

describe("thoughtSignatureStore", () => {
  beforeEach(() => __clearThoughtSignatures());

  it("returns what it stored for the same call id and family", () => {
    storeGeminiThoughtSignature("call_a", REAL_SIG, null, "gemini-3.8-flash-low");
    expect(getGeminiThoughtSignatureSync("call_a", null, "gemini-3.8-flash-low")).toBe(REAL_SIG);
  });

  it("negative control: a signature from another family is not replayed", () => {
    storeGeminiThoughtSignature("call_b", CLAUDE_SIG, null, "claude-sonnet-4-5");
    expect(getGeminiThoughtSignatureSync("call_b", null, "gemini-3.8-flash-low")).toBe(null);
    // ...but the family that produced it still gets it back.
    expect(getGeminiThoughtSignatureSync("call_b", null, "claude-sonnet-4-5")).toBe(CLAUDE_SIG);
  });

  it("negative control: an expired entry does not resurrect", () => {
    storeGeminiThoughtSignature("call_c", REAL_SIG, null, "gemini-3.8-flash-low");
    __setSignatureExpiry("call_c", Date.now() - 1);
    expect(getGeminiThoughtSignatureSync("call_c", null, "gemini-3.8-flash-low")).toBe(null);
  });

  it("session-namespaced lookups win, plain id still resolves", () => {
    storeGeminiThoughtSignature("call_d", REAL_SIG, "sess-1", "gemini-3.8-flash-low");
    expect(getGeminiThoughtSignatureSync("call_d", "sess-1", "gemini-3.8-flash-low")).toBe(REAL_SIG);
    expect(getGeminiThoughtSignatureSync("call_d", "sess-2", "gemini-3.8-flash-low")).toBe(REAL_SIG);
  });

  it("ignores empty ids and empty signatures", () => {
    storeGeminiThoughtSignature("", REAL_SIG);
    storeGeminiThoughtSignature("call_e", "");
    expect(getGeminiThoughtSignatureSync("call_e")).toBe(null);
    expect(getGeminiThoughtSignatureSync("")).toBe(null);
  });
});

describe("response -> request signature replay", () => {
  beforeEach(() => __clearThoughtSignatures());

  it("replays the exact signature the model produced for that tool call", () => {
    // 1. Backend response: a functionCall carrying a thoughtSignature.
    const state = initState(FORMATS.GEMINI);
    state.model = "ag/gemini-3.8-flash-low";
    // Argument order is (chunk format, client format): the upstream chunk is Gemini,
    // the client speaks [OI].
    const chunks = translateResponse(
      FORMATS.GEMINI,
      FORMATS.OPENAI,
      geminiChunk([
        { thoughtSignature: REAL_SIG, functionCall: { id: "call_live_1", name: "read", args: { path: "a.txt" } } },
      ]),
      state
    );
    const calls = collectToolCalls(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("call_live_1");

    // 2. Client echoes that id back with no signature (clients drop it).
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      "gemini-3.8-flash-low",
      {
        messages: [
          { role: "user", content: "read a.txt" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_live_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }],
          },
          { role: "tool", tool_call_id: "call_live_1", content: "hello" },
        ],
      },
      true,
      null,
      "gemini"
    );

    const fcParts = functionCallParts(translated);
    expect(fcParts).toHaveLength(1);
    expect(fcParts[0].thoughtSignature).toBe(REAL_SIG);
    expect(fcParts[0].thoughtSignature).not.toBe(DEFAULT_THINKING_AG_SIGNATURE);
  });

  it("negative control: an unseen call id still gets the default fallback", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      "gemini-3.8-flash-low",
      {
        messages: [
          { role: "user", content: "read a.txt" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_never_seen", type: "function", function: { name: "read", arguments: "{}" } }],
          },
        ],
      },
      true,
      null,
      "gemini"
    );
    const fcParts = functionCallParts(translated);
    expect(fcParts[0].thoughtSignature).toBe(DEFAULT_THINKING_AG_SIGNATURE);
  });

  it("parallel calls: first signed, siblings unsigned", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      "gemini-3.8-flash-low",
      {
        messages: [
          { role: "user", content: "do two things" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_p1", type: "function", function: { name: "read", arguments: "{}" } },
              { id: "call_p2", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      },
      true,
      null,
      "gemini"
    );
    const fcParts = functionCallParts(translated);
    expect(fcParts).toHaveLength(2);
    expect(fcParts[0].thoughtSignature).toBe(DEFAULT_THINKING_AG_SIGNATURE);
    expect(fcParts[1].thoughtSignature).toBeUndefined();
  });
});

describe("claude-via-antigravity envelope replays cached signatures", () => {
  beforeEach(() => __clearThoughtSignatures());

  it("replays the signature for a claude tool_use block", () => {
    storeGeminiThoughtSignature("call_claude_1", REAL_SIG, null, "claude-sonnet-4");

    const envelope = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "claude-sonnet-4",
      {
        messages: [
          { role: "user", content: "read a.txt" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_claude_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }],
          },
          { role: "tool", tool_call_id: "call_claude_1", content: "hello" },
        ],
      },
      true,
      { projectId: "proj-test", email: "t@example.test" },
      "antigravity"
    );

    const fcParts = functionCallParts(envelope?.request);
    expect(fcParts.length).toBeGreaterThan(0);
    expect(fcParts[0].thoughtSignature).toBe(REAL_SIG);
  });

  it("negative control: unseen claude call id falls back to the default", () => {
    const envelope = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "claude-sonnet-4",
      {
        messages: [
          { role: "user", content: "read a.txt" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_claude_unknown", type: "function", function: { name: "read", arguments: "{}" } }],
          },
        ],
      },
      true,
      { projectId: "proj-test", email: "t@example.test" },
      "antigravity"
    );
    const fcParts = functionCallParts(envelope?.request);
    expect(fcParts[0].thoughtSignature).toBe(DEFAULT_THINKING_AG_SIGNATURE);
  });
});

describe("antigravity executor replays cached signatures", () => {
  beforeEach(() => __clearThoughtSignatures());

  it("swaps the default for the signature that call id actually produced", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();
    storeGeminiThoughtSignature("call_exec_1", REAL_SIG, null, "gemini-3.8-flash-low");

    const body = {
      model: "gemini-3.8-flash-low",
      request: {
        contents: [
          { role: "user", parts: [{ text: "read a.txt" }] },
          { role: "model", parts: [{ functionCall: { id: "call_exec_1", name: "read", args: {} } }] },
          { role: "user", parts: [{ functionResponse: { id: "call_exec_1", name: "read", response: { ok: true } } }] },
        ],
      },
    };

    const out = ex.transformRequest("ag/gemini-3.8-flash-low", body, true, { projectId: "proj-test", email: "t@example.test" });
    const fc = functionCallParts(out.request);
    expect(fc).toHaveLength(1);
    expect(fc[0].thoughtSignature).toBe(REAL_SIG);
  });

  it("negative control: unknown call id falls back to the default", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();

    const body = {
      model: "gemini-3.8-flash-low",
      request: {
        contents: [
          { role: "user", parts: [{ text: "read a.txt" }] },
          { role: "model", parts: [{ functionCall: { id: "call_exec_unknown", name: "read", args: {} } }] },
        ],
      },
    };

    const out = ex.transformRequest("ag/gemini-3.8-flash-low", body, true, { projectId: "proj-test", email: "t@example.test" });
    const fc = functionCallParts(out.request);
    expect(fc[0].thoughtSignature).toBe(DEFAULT_THINKING_AG_SIGNATURE);
  });
});
