// [OI] → Gemini tool-call name pairing (parity with 9router-go / upstream #229).
//
// The Go oracle is internal/translator/gemini_tool_names_test.go:
// TestTranslate[OI]ToGemini_ToolResultNamePairsWithItsCall. Its five cases are
// reproduced here verbatim so the two implementations cannot drift: an [OI]
// tool_call_id is only unique within its own assistant turn, so a long agent
// session can replay one id, and the functionResponse must still carry the name
// of the call it answers — not the name of the later tool that reused the id.
//
// The last case pins the id-derived fallback: `call_nope` → `nope`.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const O2G = (body) =>
  translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "m", body, true, null, "gemini");

// Mirror of the Go helper emittedNames: functionCall / functionResponse names
// in document order.
function emittedNames(body) {
  const out = O2G(body);
  const calls = [];
  const resps = [];
  for (const content of out.contents || []) {
    for (const part of content.parts || []) {
      if (part.functionCall) calls.push(part.functionCall.name);
      if (part.functionResponse) resps.push(part.functionResponse.name);
    }
  }
  return { calls, resps };
}

describe("[OI] → Gemini tool result name pairs with its call", () => {
  it("repeated id across turns keeps each result on its own tool", () => {
    const { calls, resps } = emittedNames({
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_x", type: "function", function: { name: "edit", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_x", content: "1" },
        { role: "assistant", tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_x", content: "2" },
      ],
    });
    expect(calls).toEqual(["edit", "bash"]);
    expect(resps).toEqual(["edit", "bash"]);
  });

  it("repeated id within one turn", () => {
    const { calls, resps } = emittedNames({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "dup", type: "function", function: { name: "one", arguments: "{}" } },
            { id: "dup", type: "function", function: { name: "two", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "dup", content: "1" },
        { role: "tool", tool_call_id: "dup", content: "2" },
      ],
    });
    expect(calls).toEqual(["one", "two"]);
    expect(resps).toEqual(["one", "two"]);
  });

  it("already-unique ids are unchanged", () => {
    const { calls, resps } = emittedNames({
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_a", type: "function", function: { name: "alpha", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_a", content: "1" },
        { role: "assistant", tool_calls: [{ id: "call_b", type: "function", function: { name: "beta", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_b", content: "2" },
      ],
    });
    expect(calls).toEqual(["alpha", "beta"]);
    expect(resps).toEqual(["alpha", "beta"]);
  });

  it("extra result for a known id falls back to that id's tool name", () => {
    const { calls, resps } = emittedNames({
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_z", type: "function", function: { name: "alpha", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_z", content: "1" },
        { role: "tool", tool_call_id: "call_z", content: "2" },
      ],
    });
    expect(calls).toEqual(["alpha"]);
    expect(resps).toEqual(["alpha", "alpha"]);
  });

  it("unknown id still falls back to the id-derived name", () => {
    const { calls, resps } = emittedNames({
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_9_alpha", type: "function", function: { name: "alpha", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_nope", content: "1" },
      ],
    });
    expect(calls).toEqual(["alpha"]);
    // Two responses, both correct: the toolCall concern fills the unmatched
    // `call_9_alpha` with an empty result before translation, and `call_nope`
    // (whose call was trimmed out of the history) gets its name from the id.
    expect(resps).toEqual(["alpha", "nope"]);
  });

  it("result whose call is gone from the history is still delivered", () => {
    const { calls, resps } = emittedNames({
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "call_bash_7f3a", content: '{"ok":true}' },
      ],
    });
    expect(calls).toEqual([]);
    expect(resps).toEqual(["bash"]);
  });
});
