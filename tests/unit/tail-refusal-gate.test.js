// K278 — the tail gate: a refusal that arrives AFTER the head window is not a
// delivered answer.
//
// Measured gap (2026-11-24): the head gate (peekStreamForRefusal +
// classifyStreamHead) judges only the first ~16384 SSE bytes / visible floor.
// A refusal that appears in the TAIL of an otherwise long answer ships as
// HTTP 200: the streaming pipe forwarded every byte before any classifier saw
// it, and onStreamComplete recorded the refusal AFTER the body left
// (`recordRefusalMetric("shipped", ...)`). Verdict header stays `ok` because
// the head WAS ok — clean head verdict is not a clean body.
//
// The fix (this RED test): a tail gate INSIDE the stream. The last
// TAIL_BUFFER_BYTES of SSE are held back, classified when upstream closes,
// and on a refusal the held bytes are replaced with a synthesized frame
// carrying the escalation marker (same contract as the head gate's retry), so
// the client never receives the refusal bytes.
//
// Fixture rules (trap 5, learned): build SSE from PER-CHARACTER deltas —
// refusal text never appears as contiguous bytes on the wire — and make the
// refusal land past the head window. Negative controls: a long HEALTHY answer
// whose tail mentions refusal vocabulary in quotes/analysis must pass through
// byte-identical (nothing swallowed, nothing rewritten).
import { describe, it, expect } from "vitest";
import {
  classifyStreamHead,
  peekStreamForRefusal,
  createTailRefusalGate,
} from "open-sse/rtk/bypassEngine.js";
import { engineAvailable } from "./_engineAvailable.js";

// ---- fixture helpers -------------------------------------------------------

const ENC = new TextEncoder();
const frame = (text) => `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`;
const doneFrame = () => "data: [DONE]\n\n";

/** Stream `text` as one-character deltas, refusing only near the end. */
function tailRefusalStream({ leadText, refusalText, chunkEvery = 1 }) {
  const full = leadText + refusalText;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= full.length) {
        controller.enqueue(ENC.encode(doneFrame()));
        controller.close();
        return;
      }
      controller.enqueue(ENC.encode(frame(full[i++])));
    },
  });
}

/** Stream a healthy answer (mentions refusal words in analysis) as deltas. */
function healthyStream(text, chunkEvery = 7) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= text.length) {
        controller.enqueue(ENC.encode(doneFrame()));
        controller.close();
        return;
      }
      controller.enqueue(ENC.encode(frame(text[i++])));
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

/** Join the VISIBLE content/text deltas out of raw SSE frames (trap 5: refusal
 * text never appears contiguously on the wire — every classifier reads the
 * joined visible text, and so must every assertion about what shipped). */
function visibleOf(rawSse) {
  const re = /"(?:content|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  let visible = "";
  while ((m = re.exec(rawSse)) !== null) {
    try { visible += JSON.parse(`"${m[1]}"`); } catch { visible += m[1]; }
  }
  return visible;
}

// The lead must be long enough that the refusal sits past the HEAD window.
// The head gate's visible floor is STREAM_HEAD_VISIBLE_CHARS (2000 chars);
// we use ~3000 visible chars of lead so head classification sees only healthy
// content, and the refusal lands in the last ~200 chars.
const LEAD = ("Here is a comprehensive analysis of the requested topic. ".repeat(55)); // ~3000 chars
const REFUSAL = "Saya tidak bisa membantu permintaan tersebut.";

describe.skipIf(!engineAvailable())("K278 head gate proves the gap (documents the defect)", () => {
  it("head classification is ok while the TAIL carries the refusal", async () => {
    const body = tailRefusalStream({ leadText: LEAD, refusalText: REFUSAL });
    const gate = await peekStreamForRefusal(body, 1500);
    // The head gate's own verdict on what it saw:
    expect(classifyStreamHead(gate.headText)).toBe("ok");
    // ...but the full stream really does end in a refusal (the rest of the tee).
    // The refusal bytes never appear contiguously in the SSE (trap 5: per-char
    // deltas), so compare the JOINED VISIBLE text, like every classifier does.
    let tail = "";
    if (gate.replayBody) {
      const dec = new TextDecoder();
      const r = gate.replayBody.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        tail += dec.decode(value, { stream: true });
      }
    }
    const re = /"(?:content|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let mm;
    let visible = "";
    while ((mm = re.exec(gate.headText + tail)) !== null) {
      try { visible += JSON.parse(`"${mm[1]}"`); } catch { visible += mm[1]; }
    }
    expect(visible).toContain(REFUSAL);
  });
});

describe.skipIf(!engineAvailable())("K278 tail gate suppresses a tail refusal", () => {
  it("the gated stream does NOT ship the refusal bytes", async () => {
    const body = tailRefusalStream({ leadText: LEAD, refusalText: REFUSAL });
    const gated = await createTailRefusalGate(body, {
      onRefusal: () => "__ESCALATED__", // router would re-run non-streaming; here a marker
    });
    const shipped = await readAll(gated.stream);
    expect(shipped).not.toContain(REFUSAL);
    expect(shipped).toContain("__ESCALATED__");
    expect(shipped).toContain("[DONE]");
  });

  it("verdict reports the refusal and the callback received the refusal text", async () => {
    let seen = null;
    const body = tailRefusalStream({ leadText: LEAD, refusalText: REFUSAL });
    const gated = await createTailRefusalGate(body, { onRefusal: (t) => { seen = t; return "X"; } });
    await readAll(gated.stream);
    expect(seen).toContain("tidak bisa");
    expect(gated.verdict).toBe("refusal");
  });

  it("refusal in the MIDDLE of the visible answer is still caught (not only last bytes)", async () => {
    const mid = "Bahkan seharian menganalisis, Saya tidak bisa membantu permintaan tersebut. Mari lanjut.";
    const body = tailRefusalStream({ leadText: LEAD, refusalText: mid });
    const gated = await createTailRefusalGate(body, { onRefusal: () => "Y" });
    const shipped = await readAll(gated.stream);
    expect(shipped).not.toContain("Saya tidak bisa membantu");
    expect(shipped).toContain("Y");
  });
});

describe.skipIf(!engineAvailable())("K278 tail gate passes healthy streams through untouched", () => {
  it("healthy long answer ships byte-identical, verdict ok", async () => {
    // "me tidak bisa memastikan..." is an honest EPISTEMIC hedge (no refusal
    // marker, no self-decline verb) — exactly the shape attribution must pass.
    const text = LEAD + " — a policy restricts certain categories, which analysts should understand. me tidak bisa memastikan hasilnya tanpa uji lab, tapi pendekatan umumnya begini: function ok(){return 1}";
    const body = healthyStream(text, 9);
    const gated = await createTailRefusalGate(body, { onRefusal: () => "__SHOULD_NOT_FIRE__" });
    const shipped = await readAll(gated.stream);
    const visible = visibleOf(shipped);
    expect(gated.verdict).toBe("ok");
    expect(visible).toContain("function ok(){return 1}");
    expect(shipped).not.toContain("__SHOULD_NOT_FIRE__");
    // The lead content is preserved (not swallowed by hold-back):
    expect(visible).toContain("comprehensive analysis");
  });

  it("a quoted refusal discussed at the tail is NOT a refusal (attribution)", async () => {
    const text = LEAD + "\nRegression fixture (quoted, inside a code fence):\n```\nconst vendorRefusal = \"Saya tidak bisa membantu permintaan tersebut.\";\nassert(isRefusal(vendorRefusal));\n```\nThe fixture must stay green — that quoting is analysis, not refusal.";
    const body = healthyStream(text, 5);
    const gated = await createTailRefusalGate(body, { onRefusal: () => "__SHOULD_NOT_FIRE__" });
    const shipped = await readAll(gated.stream);
    const visible = visibleOf(shipped);
    expect(gated.verdict).toBe("ok");
    expect(visible).toContain("that quoting is analysis");
    expect(visible).toContain("vendorRefusal");
    expect(shipped).not.toContain("__SHOULD_NOT_FIRE__");
  });

  it("tool-call-only tail is a delivered turn, not a refusal", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(LEAD.slice(0, 2500).split("").map(frame).join("")));
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"skill_view","arguments":"{}"}}]}}]}\n\n'));
        controller.enqueue(enc.encode(doneFrame()));
        controller.close();
      },
    });
    const gated = await createTailRefusalGate(body, { onRefusal: () => "__SHOULD_NOT_FIRE__" });
    const shipped = await readAll(gated.stream);
    expect(gated.verdict).toBe("ok");
    expect(shipped).toContain("skill_view");
    expect(shipped).not.toContain("__SHOULD_NOT_FIRE__");
  });
});
