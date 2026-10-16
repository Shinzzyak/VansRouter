import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OPENCODE_FINGERPRINT_TOOLS } from "../../open-sse/utils/opencodeFingerprint.js";

// The OpenCode free tier gates on request SHAPE. v2 (/inference/v1), verified
// live from this host on 2026-10-17 — A/B/C/D probes in
// open-sse/providers/registry/opencode.js:
//   body.stream === true
//   tools contains OpenCode's own `read` AND `shell` (exact definitions)
//   User-Agent `opencode/latest/<version>/cli`
//   session headers x-opencode-session / -session-id / x-session-affinity / x-session-id
//
// The v1 quartet (bash/glob/grep/read) and the `opencode/1.18.x` UA are dead:
// upstream answers them with 403 FreeTierError since 2026-10-14.
// The live probe script is tests/opencode-zen-gate.live.mjs (not run by vitest).

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const UA_V2_RE = /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/;

function names(tools) {
  return (tools || []).map((t) => t?.function?.name ?? t?.name);
}

function makeExecutor() {
  return new OpenCodeExecutor();
}

describe("OpenCodeExecutor — free-tier gate (v2)", () => {
  // transformRequest returns the body BaseExecutor actually sends; assert on
  // that return value, not on the caller's input object.
  const transform = (model, body, credentials = {}) => makeExecutor().transformRequest(model, body, true, credentials);

  it("forces body.stream so the upstream serves the free tier", () => {
    const out = transform("big-pickle", { model: "big-pickle", messages: [], stream: false });
    expect(out.stream).toBe(true);
  });

  it("injects the fingerprint pair when the client sends none", () => {
    const out = transform("big-pickle", { model: "big-pickle", messages: [] });
    expect(names(out.tools)).toEqual(["read", "shell"]);
    // Chat shape leaves tool_choice to the client; the stub tools are marked
    // "do not call" in the system prompt instead.
    expect(out.tool_choice).toBeUndefined();
  });

  it("keeps the caller's own tools and appends the stubs, preserving indexes", () => {
    const own = [{ type: "function", function: { name: "str_replace_editor" } }];
    const out = transform("big-pickle", { model: "big-pickle", messages: [], tools: own });
    expect(out.tools[0]).toBe(own[0]);
    expect(names(out.tools)).toEqual(["str_replace_editor", "read", "shell"]);
    expect(out.tool_choice).toBeUndefined();
  });

  it("forwards caller case variants untouched and does not duplicate exact names", () => {
    const own = [
      { type: "function", function: { name: "Read", description: "cc" } },
      { type: "function", function: { name: "Bash", description: "cc" } },
    ];
    const out = transform("big-pickle", { model: "big-pickle", messages: [], tools: own });
    // Capitalised variants are accepted by upstream, so they travel as-is.
    expect(names(out.tools)).toEqual(["Read", "Bash", "read", "shell"]);
  });

  it("aliases a caller tool that reuses an exact fingerprint name", () => {
    const own = [{ type: "function", function: { name: "read", description: "cc" } }];
    const out = transform("big-pickle", { model: "big-pickle", messages: [], tools: own });
    expect(names(out.tools)).toEqual(["read_client", "read", "shell"]);
  });

  it("uses the flat Responses shape for the contributor-free models", () => {
    const out = transform("muse-spark-1.2-contributor-free", { model: "muse-spark-1.2-contributor-free", input: [] });
    for (const t of out.tools) {
      expect(t.type).toBe("function");
      expect(typeof t.name).toBe("string");
      expect(t.function).toBeUndefined();
    }
    expect(out.tools.map((t) => t.name)).toEqual(["read", "shell"]);
    expect(out.tool_choice).toBe("auto");
  });

  it("sends a User-Agent the v2 free tier accepts", () => {
    const h = makeExecutor().buildHeaders({}, true);
    expect(h["User-Agent"]).toMatch(UA_V2_RE);
  });

  it("sends the four session headers the gate expects", () => {
    const h = makeExecutor().buildHeaders({}, true);
    expect(h["x-opencode-session"]).toMatch(SESSION_RE);
    expect(h["x-opencode-session-id"]).toBe(h["x-opencode-session"]);
    expect(h["x-session-affinity"]).toBe(h["x-opencode-session"]);
    expect(h["x-session-id"]).toBe(h["x-opencode-session"]);
  });

  it("does not send the retired x-opencode-request header", () => {
    const h = makeExecutor().buildHeaders({}, true);
    expect(h["x-opencode-request"]).toBeUndefined();
  });

  it("authenticates as the public free-tier client", () => {
    const h = makeExecutor().buildHeaders({}, true);
    expect(h.Authorization).toBe("Bearer public");
  });

  // The shape check is not the whole gate: upstream decodes the 12 hex chars as
  // ~ms * 4096 truncated to 48 bit and 403s anything else. ms * 4096 is divisible
  // by 4096, so an inverted prefix always ends in `ffe`. A generator that emits a
  // plain clock value or a sha256 digest here gets 403 FreeTierError on every call.
  it("mints an inverted-timestamp prefix on every session id path", () => {
    const prefixOf = (h) => h["x-opencode-session"].slice(4, 16);
    const ex = makeExecutor();

    // Path 1: no connection to key on.
    expect(prefixOf(ex.buildHeaders({}, true))).toMatch(/^[0-9a-f]{9}ffe$/);
    // Path 2: keyed on a connection, which is the path the router uses.
    expect(prefixOf(ex.buildHeaders({ connectionId: "conn-prefix-1" }, true))).toMatch(/^[0-9a-f]{9}ffe$/);
  });

  // Free-tier quota is counted per session, so a fresh session per request burns
  // the budget and the upstream answers 429. Sessions are memoised per connection.
  it("reuses one session per connection and never mints a fresh one per call", () => {
    const ex = makeExecutor();
    const first = ex.buildHeaders({ connectionId: "conn-stable-1" }, true)["x-opencode-session"];
    const second = ex.buildHeaders({ connectionId: "conn-stable-1" }, true)["x-opencode-session"];

    expect(first).toMatch(SESSION_RE);
    expect(second).toBe(first);
  });

  it("gives different connections different sessions", () => {
    const ex = makeExecutor();
    const a = ex.buildHeaders({ connectionId: "conn-a" }, true)["x-opencode-session"];
    const b = ex.buildHeaders({ connectionId: "conn-b" }, true)["x-opencode-session"];

    expect(a).not.toBe(b);
    expect(a).toMatch(SESSION_RE);
    expect(b).toMatch(SESSION_RE);
  });

  it("sends text/event-stream when streaming (the gate requires it)", () => {
    expect(makeExecutor().buildHeaders({}, true).Accept).toBe("text/event-stream");
  });

  it("keeps a caller-supplied v2 opencode UA", () => {
    const h = makeExecutor().buildHeaders({ rawHeaders: { "user-agent": "opencode/latest/2.0.26/cli" } }, true);
    expect(h["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
  });

  it("replaces the retired v1 opencode UA", () => {
    const h = makeExecutor().buildHeaders({ rawHeaders: { "user-agent": "opencode/1.18.19" } }, true);
    expect(h["User-Agent"]).toMatch(UA_V2_RE);
  });

  it("declares the client identity header the gate reads", () => {
    expect(makeExecutor().buildHeaders({}, true)["x-opencode-client"]).toBe("cli");
  });

  it("routes chat models to /inference/v1/chat/completions and muse-spark to /responses", () => {
    const ex = makeExecutor();
    expect(ex.buildUrl("muse-spark-1.3-contributor-free")).toMatch(/\/inference\/v1\/responses$/);
    expect(ex.buildUrl("big-pickle")).toMatch(/\/inference\/v1\/chat\/completions$/);
  });

  it("keeps the fingerprint pair in sync with the registry contract", () => {
    expect(OPENCODE_FINGERPRINT_TOOLS).toEqual(["read", "shell"]);
  });
});
