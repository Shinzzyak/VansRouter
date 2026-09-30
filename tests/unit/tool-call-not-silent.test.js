// K25 — a 2xx that carries ONLY a tool call must not be thrown away as silence.
//
// MEASURED on the live router, 2026-09-30. `kln/glm-5.3-flash` answered an
// agent request with a valid tool call and no visible text (`content: ""`,
// `finish_reason: "tool_calls"`, 15 completion tokens). Three layers each read
// emptiness from VISIBLE TEXT alone and all three called it a failure:
//
//   1. engine `classifyStreamHead`  -> 'empty'  (the head has no content)
//   2. engine `isOutputFiltered`    -> true     (content === "" + tokens > 0)
//   3. combo `answerTextFromBody`   -> ""       -> SENYAP
//
// Chain in production: head 'empty' -> 3 escalation retries (each 26–51 s,
// each also a tool call) -> exhausted -> verdict header `empty` -> combo maps
// it to SENYAP -> `empty-refusal (SENYAP)` -> HTTP 502, model marked bad,
// candidate list burned. The client saw an empty response and never executed
// the tool call. The model was never broken.
//
// Both arms run against the DEPLOYED pair (open-sse/rtk shim + engine bundle),
// the same wiring production uses.
import { describe, it, expect } from "vitest";
import { handleComboChat, resetComboRotation } from "open-sse/services/combo.js";
import { carriesToolCalls, classifyStreamHead, isOutputFiltered } from "open-sse/rtk/bypassEngine.js";
import { engineAvailable } from "./_engineAvailable.js";

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** The production body: tool call, zero visible content, 2xx. */
const TOOLCALL_ONLY = JSON.stringify({
  choices: [{
    finish_reason: "tool_calls",
    index: 0,
    message: {
      content: "",
      reasoning_content: null,
      role: "assistant",
      tool_calls: [{
        function: { arguments: '{"name": "vansrouter-dev"}', name: "skill_view" },
        id: "call_5b933f860e154d02a127080e",
        index: 0,
        type: "function",
      }],
    },
  }],
  model: "GLM-5.3-Flash",
  object: "chat.completion",
  usage: { prompt_tokens: 96992, completion_tokens: 15, total_tokens: 97007 },
});

/** Upstream shape as SSE: role frame, tool-call frames, terminal, [DONE]. */
const TOOLCALL_HEAD = [
  'data: {"choices":[{"delta":{"content":"","reasoning_content":null,"role":"assistant"},"finish_reason":null,"index":0}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"","name":"skill_view"},"id":"call_1","index":0,"type":"function"}]},"finish_reason":null,"index":0}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"name\\": \\"vansrouter-dev\\"}"},"index":0}]},"finish_reason":null,"index":0}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
  "data: [DONE]\n\n",
].join("");

describe.skipIf(!engineAvailable())("K25: a tool-call turn is delivered, not silent", () => {
  it("carriesToolCalls reads the SSE head and the JSON body", () => {
    expect(carriesToolCalls(TOOLCALL_HEAD)).toBe(true);
    expect(carriesToolCalls(TOOLCALL_ONLY)).toBe(true);
    expect(carriesToolCalls({ choices: [{ message: { content: "", tool_calls: [] } }] })).toBe(false);
    expect(carriesToolCalls('data: {"choices":[{"delta":{"content":""}}]}\n\ndata: [DONE]\n\n')).toBe(false);
  });

  it("the head gate does NOT call a tool-call turn empty", () => {
    expect(classifyStreamHead(TOOLCALL_HEAD)).toBe("ok");
  });

  it("the output-filter detector does NOT flag a tool-call body", () => {
    expect(isOutputFiltered(JSON.parse(TOOLCALL_ONLY), true)).toBe(false);
    // The genuine output-filter signature still fires: tokens, no content,
    // no reasoning, no tool call.
    expect(isOutputFiltered({
      choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: null, role: "assistant", tool_calls: null } }],
      usage: { completion_tokens: 40, prompt_tokens: 100 },
    }, true)).toBe(true);
  });

  it("combo keeps the model: a tool-call-only 2xx is 200, not empty-refusal", async () => {
    resetComboRotation?.();
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      models: ["a/one", "b/two"],
      log: quietLog,
      comboName: "k25",
      comboStrategy: "fallback",
      handleSingleModel: async (_body, modelStr) => {
        tried.push(modelStr);
        return new Response(TOOLCALL_ONLY, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(res.status).toBe(200);
    expect(tried).toEqual(["a/one"]);
    const body = await res.clone().text();
    expect(body).toContain("skill_view");
  });

  it("combo still burns the list when the body is genuinely empty", async () => {
    resetComboRotation?.();
    const tried = [];
    const empty = JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: null, role: "assistant", tool_calls: null } }],
      usage: { completion_tokens: 40, prompt_tokens: 100 },
    });
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      models: ["a/one", "b/two"],
      log: quietLog,
      comboName: "k25-empty",
      comboStrategy: "fallback",
      handleSingleModel: async (_body, modelStr) => {
        tried.push(modelStr);
        return new Response(empty, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(tried).toEqual(["a/one", "b/two"]);
    expect(res.status).toBe(502);
    expect(await res.clone().text()).toContain("SENYAP");
  });
});
