/**
 * K29 guard — SSE frames rebuilt by the brand gate must be terminated by a BLANK
 * LINE, never by whatever the first held chunk happened to end with.
 *
 * The regression this locks down (2026-10-03): `rebuildStreamWithText()` derived
 * its frame terminator from the trailing bytes of the first held chunk. A chunk
 * boundary landing after the payload's single "\n" made every rebuilt frame emit
 * `data: {...}\n` with no blank line. Spec-compliant SSE clients (the [OI] Python
 * SDK Hermes uses) then parsed ZERO events and reported empty content, which
 * aborted context compaction. The router saw a clean 200 with hundreds of KB sent;
 * only the client could not read it.
 *
 * A test that only asserts "the repaired text is present" passes on the broken
 * build — the bytes really are there. It must assert on FRAMING, so every
 * assertion below is made on the raw string, never on a split-and-rejoin.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(__dirname, "../..");

/**
 * Split an SSE body into frames the way a spec-compliant client does: a frame
 * ends at a blank line. A body with no blank lines is ONE unterminated frame.
 */
function sseFrames(body) {
  return body.split(/\r\n\r\n|\n\n|\r\r/).filter((f) => f.trim() !== "");
}

/** Count data payloads a client would actually dispatch. */
function sseEventCount(body) {
  return sseFrames(body)
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(5).trim())
    .filter((p) => p && p !== "[DONE]").length;
}

/** Blank-line separators present in the body (what the broken build emitted: 0). */
function blankSeparators(body) {
  return (body.match(/\r\n\r\n|\n\n|\r\r/g) || []).length;
}

const chunk = (content, finish) =>
  `data: ${JSON.stringify({
    id: "cmb-test",
    model: "test-model",
    object: "chat.completion.chunk",
    created: 1,
    choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }],
  })}\n\n`;

let rebuildStreamWithText;
let collectReasoningFrames;

beforeAll(async () => {
  const mod = await import(
    pathToFileURL(resolve(ROOT, "open-sse/rtk/streamEnforce.js")).href
  );
  rebuildStreamWithText = mod.rebuildStreamWithText;
  collectReasoningFrames = mod.collectReasoningFrames;
});

describe("K29 — rebuilt SSE framing is protocol-constant", () => {
  // The trigger: the first held chunk was cut at a boundary that left a single
  // "\n" instead of the payload's blank line. All variants must produce the
  // same, readable stream.
  const CASES = [
    ["chunk ends with the blank line", chunk("no brand here.")],
    ["chunk cut after a single \\n", chunk("no brand here.").slice(0, -1)],
    ["chunk carries no terminator at all", chunk("no brand here.").replace(/\n\n$/, "")],
  ];

  it.each(CASES)("%s — body has one blank separator per frame", (_label, first) => {
    const stream = [first, chunk("", "stop"), "data: [DONE]\n\n"];
    const out = rebuildStreamWithText(stream.slice(), "no brand here.");
    expect(out, "rebuild refused a shape it should handle").toBeTruthy();

    const frames = sseFrames(out);
    const dataFrames = frames.filter((f) => f.trim().startsWith("data:"));
    expect(dataFrames.length).toBeGreaterThan(0);
    // One blank line per emitted frame: the count must match, not merely be > 0.
    expect(blankSeparators(out)).toBe(frames.length);
  });

  it("the client sees the same events regardless of chunk-boundary luck", () => {
    const results = CASES.map(([, first]) => {
      const stream = [first, chunk("", "stop"), "data: [DONE]\n\n"];
      const out = rebuildStreamWithText(stream.slice(), "no brand here.");
      return { out, events: sseEventCount(out) };
    });

    // The payload really is in the bytes — this is what the broken build passed.
    for (const { out } of results) {
      expect(out).toContain("no brand here.");
    }
    // ...but only the framed build is readable. Broken build: 0 events.
    for (const { events, out } of results) {
      expect(
        events,
        `client parsed ${events} events; body started ${JSON.stringify(out.slice(0, 140))}`
      ).toBeGreaterThan(0);
    }
    // Boundary position must not change the outcome.
    expect(new Set(results.map((r) => r.events)).size).toBe(1);
  });

  it("reasoning frames keep their own blank-line terminator too", () => {
    const reasoning =
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: null }],
      })}\n\n`;
    const stream = [
      chunk("no brand here.").slice(0, -1),
      reasoning,
      chunk("", "stop"),
      "data: [DONE]\n\n",
    ];
    // Same call shape as the gate's flush handler: deliberation is passed as its
    // own channel, collected from the held bytes.
    const out = rebuildStreamWithText(
      stream.slice(),
      "no brand here.",
      collectReasoningFrames(stream.slice())
    );
    const frames = sseFrames(out);
    expect(blankSeparators(out)).toBe(frames.length);
    expect(out).toContain("thinking");
  });
});
