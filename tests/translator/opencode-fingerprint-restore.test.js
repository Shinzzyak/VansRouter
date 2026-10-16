/**
 * Streaming counterpart of tests/unit/opencode-fingerprint.test.js.
 *
 * OpenCode's free tier (v2, /inference/v1) only accepts its own `read`/`shell`
 * definitions, so a caller tool that reuses one of those exact names with a
 * different definition is sent under an alias (`read_client`). translateResponse()
 * must rename it back on the way out — the caller never registered the alias and
 * would reject the tool call as an unknown tool.
 *
 * Caller tools with any other spelling, including case variants such as `Read`,
 * are forwarded verbatim and never appear in the rename map.
 */
import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";

const CREDS = { connectionId: "opencode-fingerprint-stream-test" };
// `read` (lowercase, custom definition) collides with the fingerprint name and
// gets aliased; `Read` (capitalised) is forwarded as-is.
const COLLIDING_TOOLS = [
  { type: "function", function: { name: "read", description: "cc" } },
  { type: "function", function: { name: "Read", description: "cc" } },
];

// Mirrors chatCore: the executor renames tools on the body it was handed, and
// that same map is threaded into the response state.
function fingerprintMapFor(model) {
  const body = { messages: [{ role: "user", content: "hi" }], tools: structuredClone(COLLIDING_TOOLS) };
  new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
  return takeRenamedToolNames(body);
}

const openaiToolChunk = (name) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "{}" } }] } }]
});

describe("OpenCode fingerprint rename → client stream", () => {
  it("restores the original name in an [OI] stream (same-format passthrough)", () => {
    const state = { toolNameMap: fingerprintMapFor("big-pickle") };
    const [out] = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, openaiToolChunk("read_client"), state);

    expect(out.choices[0].delta.tool_calls[0].function.name).toBe("read");
  });

  it("restores the original name in a Claude stream (openai → claude pivot)", () => {
    const state = { ...initState(FORMATS.CLAUDE), toolNameMap: fingerprintMapFor("big-pickle") };
    const results = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, openaiToolChunk("read_client"), state);
    const start = results.find((chunk) => chunk?.type === "content_block_start");

    expect(start.content_block.type).toBe("tool_use");
    expect(start.content_block.name).toBe("read");
  });

  it("leaves a capitalised case variant untouched — it is never aliased", () => {
    const map = fingerprintMapFor("big-pickle");
    expect(map?.has("Read")).toBe(false);
    const state = { toolNameMap: map };
    const [out] = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, openaiToolChunk("Read"), state);

    expect(out.choices[0].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("leaves the stream untouched when the provider renamed nothing", () => {
    const [out] = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, openaiToolChunk("read_client"), {});
    expect(out.choices[0].delta.tool_calls[0].function.name).toBe("read_client");
  });
});
