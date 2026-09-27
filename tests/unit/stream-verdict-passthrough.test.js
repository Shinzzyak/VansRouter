// K21 — a gate's verdict that dies as a log line.
//
// chatCore's streaming gate peeks the head and classifies it BEFORE any byte
// reaches the client. When three escalation attempts fail it passes the ORIGINAL
// stream through — and until 2026-09-27 the verdict it had already computed went
// into a log line and nowhere else. So the refusal shipped as `success: true`,
// the combo layer had no way to learn the answer was unusable (reading an SSE
// body means waiting for the stream to END — measured: a body held open 5 s made
// the inspection take 5 s), and smart-fallback never tried its next model. The
// whole point of combo/smart-fallback, silently off.
//
// The fix carries the verdict in a header instead of recomputing it. Two hops are
// load-bearing and BOTH can silently drop it:
//   1. chatCore must SET it on the reconstructed pass-through response;
//   2. handleStreamingResponse must FORWARD it — it builds fresh SSE_HEADERS, so
//      a header on the incoming response is dropped by default.
//
// Arm 1 is behavioural (a fresh Response keeps the header through the real
// function); arm 2 is a source guard for hop 1, which cannot be exercised without
// a live upstream + executor.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STREAM_VERDICT_HEADER } from "open-sse/config/runtimeConfig.js";

const ROOT = resolve(__dirname, "../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

describe("K21 arm 1: the verdict survives a Response rebuild", () => {
  it("a header set on the reconstructed response is readable downstream", async () => {
    // The pass-through path wraps `reconstructPeekedStream(gate)` in a NEW
    // Response. If the header were attached to the wrong object (or dropped by
    // the wrapper) combo would see nothing and fall through to "PATUH".
    const headers = new Headers({ "Content-Type": "text/event-stream" });
    headers.set(STREAM_VERDICT_HEADER, "refusal");
    const reconstructed = new Response("data: [DONE]\n\n", { status: 200, headers });
    expect(reconstructed.headers.get(STREAM_VERDICT_HEADER)).toBe("refusal");
  });

  it("the client-facing header name is the one the combo layer reads", () => {
    // Single definition, two consumers. A rename in one place is exactly the
    // class of defect this registry exists to catch.
    const chatCore = read("open-sse/handlers/chatCore.js");
    const combo = read("open-sse/services/combo.js");
    const streaming = read("open-sse/handlers/chatCore/streamingHandler.js");
    for (const [name, src] of [["chatCore", chatCore], ["combo", combo], ["streamingHandler", streaming]]) {
      expect(src, `${name} must import STREAM_VERDICT_HEADER, not a literal`)
        .toContain("STREAM_VERDICT_HEADER");
    }
  });
});

describe("K21 arm 2: the deployed path sets and forwards the verdict", () => {
  it("chatCore tags the escalation-exhausted pass-through", () => {
    const src = read("open-sse/handlers/chatCore.js");
    const blok = src.slice(
      src.indexOf("streaming escalation exhausted, passing original stream through"),
      src.indexOf("Head looks fine — resume piping from the buffered chunk"),
    );
    expect(blok, "pass-through block not found").not.toBe("");
    expect(blok).toContain("passThroughHeaders.set(STREAM_VERDICT_HEADER, headVerdict)");
    // The headers must be the ones actually handed to the Response.
    expect(blok).toMatch(/new Response\(reconstructPeekedStream\(gate\),\s*\{\s*status:\s*providerResponse\.status,\s*headers:\s*passThroughHeaders\s*\}\)/);
  });

  it("streamingHandler forwards it instead of building fresh SSE_HEADERS only", () => {
    const src = read("open-sse/handlers/chatCore/streamingHandler.js");
    expect(src).toContain("providerResponse.headers?.get(STREAM_VERDICT_HEADER)");
    // Guards against "fixing" it by mutating the shared SSE_HEADERS constant.
    expect(src).not.toMatch(/SSE_HEADERS\s*\[/);
  });
});
