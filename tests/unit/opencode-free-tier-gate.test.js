import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

// The OpenCode free tier (/zen/v1) gates on request shape. These are the four
// conditions verified live on two independent hosts on 2026-09-22:
//   body.stream === true
//   tools contains one named `bash` AND one named `read`
//   User-Agent `opencode/<version>` with version >= 1.18.0
//   x-opencode-session `ses_` + 12 lowercase hex + 14 base62
//
// The live A/B proof lives in tests/opencode-zen-gate.live.mjs (not run by vitest).

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const UA_RE = /^opencode\/(\d+)\.(\d+)\.(\d+)/;

function names(tools) {
  return (tools || []).map((t) => t?.function?.name ?? t?.name);
}

function makeExecutor() {
  return new OpenCodeExecutor();
}

describe("OpenCodeExecutor — free-tier gate", () => {
  // transformRequest returns the body BaseExecutor actually sends; assert on
  // that return value, not on the caller's input object.
  const transform = (model, body, credentials = {}) => makeExecutor().transformRequest(model, body, true, credentials);

  it("forces body.stream so the upstream serves the free tier", () => {
    const out = transform("mimo-v2.5-free", { model: "mimo-v2.5-free", messages: [], stream: false });
    expect(out.stream).toBe(true);
  });

  it("injects the two gate tools when the client sends none", () => {
    const out = transform("mimo-v2.5-free", { model: "mimo-v2.5-free", messages: [] });
    expect(names(out.tools)).toContain("bash");
    expect(names(out.tools)).toContain("read");
  });

  it("keeps the caller's own tools and appends the stubs, preserving indexes", () => {
    const own = [{ type: "function", function: { name: "str_replace_editor" } }];
    const out = transform("mimo-v2.5-free", { model: "mimo-v2.5-free", messages: [], tools: own });
    expect(out.tools[0]).toBe(own[0]);
    expect(names(out.tools)).toEqual(["str_replace_editor", "bash", "read"]);
  });

  it("does not duplicate tools the caller already provides", () => {
    const own = [
      { type: "function", function: { name: "bash", description: "real bash" } },
      { type: "function", function: { name: "read", description: "real read" } },
    ];
    const out = transform("mimo-v2.5-free", { model: "mimo-v2.5-free", messages: [], tools: own });
    expect(out.tools).toEqual(own);
  });

  it("uses the flat Responses shape for /zen/v1/responses models", () => {
    const out = transform("muse-spark-1.2-contributor-free", { model: "muse-spark-1.2-contributor-free", input: [] });
    for (const t of out.tools) {
      expect(t.type).toBe("function");
      expect(typeof t.name).toBe("string");
      expect(t.function).toBeUndefined();
    }
    expect(out.tools.map((t) => t.name)).toEqual(["bash", "read"]);
  });

  it("sends a User-Agent the free tier accepts (opencode >= 1.18.0)", () => {
    const ex = makeExecutor();
    const h = ex.buildHeaders({}, true);
    expect(h["User-Agent"]).toMatch(UA_RE);
    const [, maj, min] = h["User-Agent"].match(UA_RE);
    expect(Number(maj)).toBeGreaterThanOrEqual(1);
    if (Number(maj) === 1) expect(Number(min)).toBeGreaterThanOrEqual(18);
  });

  it("generates a session id in the shape the gate accepts", () => {
    const ex = makeExecutor();
    const h = ex.buildHeaders({}, true);
    expect(h["x-opencode-session"]).toMatch(SESSION_RE);
  });

  it("generates a distinct session id per call", () => {
    const ex = makeExecutor();
    const a = ex.buildHeaders({}, true)["x-opencode-session"];
    const b = ex.buildHeaders({}, true)["x-opencode-session"];
    expect(a).not.toBe(b);
  });

  it("sends text/event-stream when streaming (the gate requires it)", () => {
    const ex = makeExecutor();
    expect(ex.buildHeaders({}, true).Accept).toBe("text/event-stream");
  });

  it("keeps a caller-supplied opencode UA that carries a version", () => {
    const ex = makeExecutor();
    const h = ex.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.19.0" } }, true);
    expect(h["User-Agent"]).toBe("opencode/1.19.0");
  });

  it("does not forward a versionless opencode UA (the gate needs a version)", () => {
    const ex = makeExecutor();
    const h = ex.buildHeaders({ rawHeaders: { "user-agent": "opencode" } }, true);
    expect(h["User-Agent"]).toMatch(UA_RE);
  });

  it("does not let CLI-header synthesis reinstate the rejected identity", () => {
    const prev = process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
    process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = "true";
    try {
      const ex = makeExecutor();
      const h = ex.buildHeaders({}, true);
      expect(h["User-Agent"]).toMatch(UA_RE);
      expect(h["x-opencode-session"]).toMatch(SESSION_RE);
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
      else process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = prev;
    }
  });

  it("honours an explicit OPENCODE_CLI_USER_AGENT override", () => {
    const prev = process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
    const prevUa = process.env.OPENCODE_CLI_USER_AGENT;
    process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = "true";
    process.env.OPENCODE_CLI_USER_AGENT = "opencode/1.20.0";
    try {
      const ex = makeExecutor();
      expect(ex.buildHeaders({}, true)["User-Agent"]).toBe("opencode/1.20.0");
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
      else process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = prev;
      if (prevUa === undefined) delete process.env.OPENCODE_CLI_USER_AGENT;
      else process.env.OPENCODE_CLI_USER_AGENT = prevUa;
    }
  });

  it("routes the two contributor-free models to the responses endpoint", () => {
    const ex = makeExecutor();
    expect(ex.buildUrl("muse-spark-1.3-contributor-free")).toMatch(/\/zen\/v1\/responses$/);
    expect(ex.buildUrl("mimo-v2.5-free")).toMatch(/\/zen\/v1\/chat\/completions$/);
  });
});
