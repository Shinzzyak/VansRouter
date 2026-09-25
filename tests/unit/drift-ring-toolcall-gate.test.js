// Guards for the drift-ring false signal (2026-09-25).
//
// THE DEFECT. `onStreamComplete` classifies the assembled stream text and feeds
// two consumers: the drift ring (`recordIntegrity`) and the framing ledger
// (`recordOutcome`). A tool-call-only turn produces no visible text BY DESIGN —
// the model called a tool, which is a successful agent turn — and
// `classifyStreamContent` correctly calls that absent text EMPTY.
//
// The LEDGER was gated against that on 2026-09-22. The RING was not. So every
// tool-call turn was counted as a model-quality failure in the ring.
//
// Measured on the live router: the ring printed
//   codebuddy-intl/deepseek-v4.1-flash   n=50  refusal=0% brand=0% empty=90%
// which reads as a broken model. `requestDetails` for that same model:
//   566 rows `empty_reason=tool_calls`, 31 rows `None` — and the 1,447
//   content-safety 403s in the same log never reach this code at all, because a
//   4xx returns from the !ok branch before the streaming handler is built.
// The model was healthy. The ring was counting tool calls.
//
// This suite asserts BOTH halves: the ring skips a tool-call empty, and the ring
// still records a genuine empty (a stream that died with no text and no tool
// call). A gate that swallows both would hide real failures.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("the drift ring does not count tool-call turns as model failures", () => {
  const src = read("open-sse/handlers/chatCore/streamingHandler.js");

  it("computes one toolCallOnly verdict and uses it for the ring", () => {
    expect(src).toMatch(/const toolCallOnly = sawToolCalls \|\| finishReason === "tool_calls"/);
    // The ring call must receive the adjusted status, not the raw verdict.
    expect(src).toMatch(/recordIntegrity\(provider, model, ringStatus\)/);
    expect(src).toMatch(
      /const ringStatus = toolCallOnly && integrity\.status === INTEGRITY\.EMPTY\s*\n\s*\? INTEGRITY\.OK\s*\n\s*: integrity\.status/,
    );
  });

  it("the ledger gate and the ring gate read the SAME variable", () => {
    // Two independent `sawToolCalls || finishReason === "tool_calls"` expressions
    // is how the two consumers drifted apart in the first place. One variable,
    // two readers.
    const occurrences = src.match(/sawToolCalls \|\| finishReason === "tool_calls"/g) || [];
    expect(occurrences).toHaveLength(1);
    expect(src).toMatch(/kelas === "SENYAP" && toolCallOnly/);
  });

  it("the ring only downgrades EMPTY — a real refusal or brand miss still lands", () => {
    // A tool-call turn that ALSO produced refusal text or dropped the brand is a
    // real signal and must keep its verdict. Only the absence of text is excused.
    expect(src).toMatch(/toolCallOnly && integrity\.status === INTEGRITY\.EMPTY/);
  });

  it("no upstream-status plumbing is left behind", () => {
    // An earlier hypothesis blamed 4xx content-safety rejections for the same
    // ring rows. Disproved: a 4xx returns from the !ok branch (chatCore.js) and
    // never reaches buildOnStreamComplete. The plumbing added for it was removed
    // rather than left as a plausible-looking no-op.
    expect(src).not.toMatch(/upstreamStatus/);
    expect(read("open-sse/handlers/chatCore.js")).not.toMatch(/upstreamStatus/);
  });
});

describe("the retraction is documented where the next reader will look", () => {
  it("the comment names the disproved cause, not just the fix", () => {
    const src = read("open-sse/handlers/chatCore/streamingHandler.js");
    expect(src).toMatch(/never reach this code at all/);
    expect(src).toMatch(/the RING never did/);
  });
});
