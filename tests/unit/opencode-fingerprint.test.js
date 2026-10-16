/**
 * OpenCode free tier (v2, /inference/v1) requires OpenCode's own `read` and
 * `shell` tools with their exact descriptions and parameter schemas on every
 * request; a stub definition, a renamed schema or tool_choice "none" is
 * answered with 403 FreeTierError.
 *
 * Caller tools travel untouched — upstream accepts case variants such as
 * `Read` alongside `read`. Only a caller tool that reuses an exact fingerprint
 * name with a *different* definition is aliased (`read_client`), and the
 * response side must hand that caller its original name back, otherwise the
 * client rejects the tool call as an unknown tool.
 *
 * Contract change 2026-10-17: the v1 quartet (bash/glob/grep/read) is dead —
 * the gate moved to the read/shell pair. See
 * open-sse/providers/registry/opencode.js for the A/B probes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const {
  OPENCODE_FINGERPRINT_TOOLS,
  appendMissingFingerprintTools,
  applyFingerprintTools,
  concealFingerprintToolNames,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
} = await import("../../open-sse/utils/opencodeFingerprint.js");
const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const CREDS = { connectionId: "opencode-fingerprint-test" };
const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));
const namesOf = (tools) => tools.map((tool) => tool.name ?? tool.function?.name);

describe("opencodeFingerprint — request side", () => {
  it("appends exact read/shell definitions and leaves case variants untouched", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual([...CC_TOOLS, ...OPENCODE_FINGERPRINT_TOOLS]);
    expect(map.size).toBe(0);
    const shell = body.tools.find((tool) => tool.name === "shell");
    expect(shell.description).toMatch(/^Execute a shell command/);
    expect(shell.parameters.required).toEqual(["command"]);
    expect(shell.strict).toBe(false);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["Edit", "read", "shell"]);
    const read = body.tools.find((tool) => tool.function?.name === "read");
    expect(read.function.parameters.required).toEqual(["path"]);
  });

  it("aliases a caller tool that reuses an exact fingerprint name", () => {
    const body = { tools: flat(["read", "read_client", "Edit"]) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client2", "read_client", "Edit", "read", "shell"]);
    expect(map.get("read_client2")).toBe("read");
  });

  it("keeps a caller tool that already carries OpenCode's exact definition", () => {
    const first = { tools: [] };
    applyFingerprintTools(first, true);
    const official = first.tools.map((tool) => ({ ...tool }));

    const body = { tools: official };
    const map = applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(map.size).toBe(0);
    expect(body.instructions).toBeUndefined();
  });

  it("drops duplicate declarations of one fingerprint name", () => {
    const body = { tools: flat(["shell", "shell"]) };
    applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(["shell_client", "read", "shell"]);
  });

  it("defaults Responses tool_choice to auto and never to none for chat", () => {
    const responses = { tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.tool_choice).toBe("auto");

    const chatBody = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(namesOf(chatBody.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(chatBody.tool_choice).toBeUndefined();
  });

  it("tells the model the appended tools are placeholders", () => {
    const responses = { instructions: "Be brief.", tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.instructions).toMatch(/^Be brief\.\n\nDo not call the `read` or `shell` tools;/);

    const chatBody = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(chatBody.messages).toHaveLength(2);
    expect(chatBody.messages[0].content).toMatch(/^Be brief\.\n\nDo not call the `read` or `shell` tools;/);

    const noSystem = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(noSystem, false);
    expect(noSystem.messages[0]).toEqual({ role: "system", content: expect.stringMatching(/^Do not call/) });

    const claudeShape = { system: "Be brief.", messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(claudeShape, false);
    expect(claudeShape.messages).toHaveLength(1);
  });

  it("retargets flat tool_choice that points at an aliased tool", () => {
    const body = { tools: flat(["shell"]), tool_choice: { type: "function", name: "shell" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("shell_client");
  });

  it("retargets nested tool_choice that points at an aliased tool", () => {
    const body = {
      tools: chat(["read"]),
      tool_choice: { type: "function", function: { name: "read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read_client");
  });

  it("records the rename map against the body for the response side", () => {
    const body = { tools: flat(["read"]) };
    const map = applyFingerprintTools(body, true);
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["read_client", "read"], ["shell_client", "shell"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "read_client", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("read");
    expect(chunk.content_block.name).toBe("read_client");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "shell_client", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("shell");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "read_client", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("read");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "shell_client", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read_client", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "read_client", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("read");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "shell_client", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("shell");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "read_client" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("matches exact fingerprint names only", () => {
    expect(fingerprintToolKey("read")).toBe("read");
    expect(fingerprintToolKey(" shell ")).toBe("shell");
    expect(fingerprintToolKey("Read")).toBe("");
    expect(fingerprintToolKey("bash")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});

describe("opencode free-tier fingerprint round trip", () => {
  it("sends read/shell and returns the caller's own spelling for an aliased tool", () => {
    // A caller tool literally named `read` but with its own definition gets
    // aliased; a capitalised `Read` is left alone (upstream accepts it).
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "cc" } }],
    };
    const out = new OpenCodeExecutor().transformRequest("big-pickle", body, true, CREDS);
    const map = takeRenamedToolNames(body);

    expect(out.tools.map((tool) => tool.function.name)).toEqual(["read_client", "read", "shell"]);
    expect([...map]).toEqual([["read_client", "read"]]);
    expect(OPENCODE_FINGERPRINT_TOOLS).toEqual(["read", "shell"]);
  });

  it("non-streaming Responses client gets function_call items under the original names", async () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "cc" } }],
    };
    const transformed = new OpenCodeExecutor().transformRequest("muse-spark-1.2-contributor-free", body, true, CREDS);
    const toolNameMap = takeRenamedToolNames(body);

    const sse = [
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"function_call","name":"read_client","call_id":"c1","arguments":"{}"}}',
      'event: response.completed\ndata: {"response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}',
      ""
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      provider: "opencode",
      model: "muse-spark-1.2-contributor-free",
      body,
      stream: false,
      translatedBody: transformed,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      toolNameMap,
      trackDone: vi.fn(),
      appendLog: vi.fn()
    });

    const json = await result.response.json();
    expect(json.output[0].name).toBe("read");
    expect(json.output[0].arguments).toBe("{}");
  });
});
