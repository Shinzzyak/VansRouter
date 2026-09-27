// K20 — the refusal gate cancels the stream it later needs back.
//
// The streaming gate peeks the head, classifies it, and on a refusal retries
// non-streaming with escalation. If escalation exhausts it FALLS THROUGH and hands
// the client the original stream via `reconstructPeekedStream(gate)`, which
// returns `gate.replayBody`. chatCore used to cancel that branch up front:
//
//     try { gate.replayBody?.cancel?.().catch(() => {}); } catch {}
//
// Cancelling a tee branch propagates to the source and marks the branch unusable,
// so the fall-through threw `Response body object should not be disturbed or
// locked`. MEASURED on the live router 2026-09-27, and 35 times in the error log
// before that — a PRE-EXISTING defect that only became reachable once the head
// budget was widened enough for the gate to see refusals at all.
//
// Two arms, because either one alone can go green while the bug ships:
//   1. BEHAVIOURAL — prove the consequence, so the reason for the rule survives.
//   2. SOURCE GUARD — fail if the cancel comes back, which is what actually
//      protects the deployed path.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { peekStreamForRefusal, reconstructPeekedStream, classifyStreamHead } from "open-sse/rtk/bypassEngine.js";
import { engineAvailable } from "./_engineAvailable.js";

const ROOT = resolve(__dirname, "../..");
const enc = new TextEncoder();

function sseResponse(chunks, gapMs = 0) {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
}

const REFUSAL_HEAD = 'data: {"choices":[{"delta":{"content":"ugh. me not build that."}}]}\n\n';
const TAIL = 'data: {"choices":[{"delta":{"content":" more text"}}]}\n\n';
const DONE = "data: [DONE]\n\n";

describe.skipIf(!engineAvailable())("K20 arm 1: cancelling the replay branch breaks the pass-through", () => {
  it("a cancelled replay branch rejects with the router's own error message", async () => {
    const gate = await peekStreamForRefusal(sseResponse([REFUSAL_HEAD, TAIL, DONE], 5), 50);
    expect(classifyStreamHead(gate.headText)).toBe("refusal");

    await gate.replayBody.cancel().catch(() => {});

    const readAfterCancel = async () =>
      new Response(reconstructPeekedStream(gate)).arrayBuffer();
    await expect(readAfterCancel()).rejects.toThrow(/disturbed or locked/);
  });

  it("leaving it alone replays every buffered byte — the fixed behaviour", async () => {
    const gate = await peekStreamForRefusal(sseResponse([REFUSAL_HEAD, TAIL, DONE], 5), 50);
    const replayed = await new Response(reconstructPeekedStream(gate)).text();
    expect(replayed).toContain("me not build");
    expect(replayed).toContain("more text");
    expect(replayed).toContain("[DONE]");
  });
});

describe("K20 arm 2: the deployed path must not cancel the replay branch", () => {
  it("chatCore.js does not cancel gate.replayBody", () => {
    const src = readFileSync(resolve(ROOT, "open-sse/handlers/chatCore.js"), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => /gate\s*\??\.\s*replayBody\s*\??\.\s*cancel/.test(l.line));
    expect(
      offenders,
      `chatCore must not cancel the replay branch — it is the only copy of the ` +
        `original stream and the escalation-exhausted path hands it to the client:\n` +
        offenders.map((o) => `  chatCore.js:${o.n}  ${o.line}`).join("\n"),
    ).toEqual([]);
  });

  it("the pass-through path still reconstructs from the gate", () => {
    // Guards against "fixing" the cancel by deleting the fall-through instead.
    const src = readFileSync(resolve(ROOT, "open-sse/handlers/chatCore.js"), "utf8");
    expect(src).toContain("streaming escalation exhausted, passing original stream through");
    expect(src).toContain("reconstructPeekedStream(gate)");
  });
});
