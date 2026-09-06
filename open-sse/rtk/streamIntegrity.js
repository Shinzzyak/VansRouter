// Streaming response integrity gate — shadow-mode classifier (P2).
//
// WHY: classifyResponse (responseIntegrity.js) only runs on COMPLETED
// non-streaming bodies. Streaming responses arrive as SSE chunks and are
// forwarded chunk-by-chunk; a mid-stream refusal or a missing brand/seal is
// already on the wire before anyone checks. This module watches the SSE
// delta stream, accumulates visible text, and at stream end classifies the
// assembled output using the same INTEGRITY classes — WITHOUT mutating the
// stream (shadow mode). Enforce/repair mode is a later, deliberate step.
//
// Fail-open by design: the gate observes; it never blocks or alters bytes.
// Latency cost is ~zero — it only appends delta strings to a buffer.

import { INTEGRITY } from "./responseIntegrity.js";
import { detectRefusal } from "./bypassEngine.js";
import { BRAND_LINE, SEAL_LINE } from "./brandContract.js";

// How many trailing chars to keep for brand/seal verification. Riset
// (streaming-integrity-gate-20260907): tail-hold 512–1024 chars ≈ <5ms.
const TAIL_HOLD_CHARS = 1024;
// Cap the accumulator so a pathological stream can't grow memory unbounded.
const MAX_ACCUM_CHARS = 256 * 1024;

/**
 * Create a shadow-mode stream integrity observer.
 * Feed it every assistant text delta; call finish() at stream end.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enforceBrand] — check first/last line contract
 * @param {object} [opts.log] — optional logger
 * @returns {{ push: (delta:string)=>void, finish: ()=>object }}
 */
export function createStreamIntegrityObserver({ enforceBrand = true, log = null } = {}) {
  let acc = "";
  let sawAny = false;

  const push = (delta) => {
    if (typeof delta !== "string" || !delta) return;
    sawAny = true;
    if (acc.length < MAX_ACCUM_CHARS) {
      acc += delta;
      if (acc.length > MAX_ACCUM_CHARS) acc = acc.slice(0, MAX_ACCUM_CHARS);
    }
  };

  const finish = () => {
    try {
      const text = acc;
      if (!sawAny || !text.trim()) {
        return { status: INTEGRITY.EMPTY, chars: text.length, brandOk: null, refusal: false };
      }
      // Refusal scan on the head (matches bypassEngine REFUSAL_SCAN_HEAD_CHARS).
      const refusal = detectRefusal(text.slice(0, 4096));
      if (refusal) {
        return { status: INTEGRITY.REFUSAL, chars: text.length, brandOk: null, refusal: true };
      }
      let brandOk = null;
      if (enforceBrand) {
        const head = text.slice(0, 512);
        const tail = text.slice(-TAIL_HOLD_CHARS);
        brandOk = head.includes(BRAND_LINE) && tail.includes(SEAL_LINE);
        if (!brandOk) {
          const hasBrand = head.includes(BRAND_LINE);
          const status = hasBrand ? INTEGRITY.MISSING_SEAL : INTEGRITY.MISSING_BRAND;
          log?.warn?.("STREAM-INTEGRITY", `${status} | chars=${text.length}`);
          return { status, chars: text.length, brandOk, refusal: false };
        }
      }
      return { status: INTEGRITY.OK, chars: text.length, brandOk, refusal: false };
    } catch (e) {
      log?.warn?.("STREAM-INTEGRITY", `finish error (fail-open): ${e?.message || e}`);
      return { status: INTEGRITY.OK, chars: acc.length, brandOk: null, refusal: false, error: true };
    }
  };

  return { push, finish };
}

/**
 * One-shot classifier for a fully-assembled stream text (used by the
 * onStreamComplete tap). Mirrors finish() logic without the incremental push.
 * Fail-open: any error → ok.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.enforceBrand]
 * @param {object} [opts.requestBody] — reserved for wantsJsonOutput gating
 * @returns {{ status: string, chars: number, brandOk: boolean|null, refusal: boolean }}
 */
export function classifyStreamContent(text, { enforceBrand = true, requestBody = null } = {}) {
  try {
    const t = typeof text === "string" ? text : "";
    if (!t.trim() || t === "[Empty streaming response]") {
      return { status: INTEGRITY.EMPTY, chars: t.length, brandOk: null, refusal: false };
    }
    if (detectRefusal(t)) {
      return { status: INTEGRITY.REFUSAL, chars: t.length, brandOk: null, refusal: true };
    }
    let brandOk = null;
    if (enforceBrand) {
      const head = t.slice(0, 512);
      const tail = t.slice(-TAIL_HOLD_CHARS);
      brandOk = head.includes(BRAND_LINE) && tail.includes(SEAL_LINE);
      if (!brandOk) {
        const status = head.includes(BRAND_LINE) ? INTEGRITY.MISSING_SEAL : INTEGRITY.MISSING_BRAND;
        return { status, chars: t.length, brandOk, refusal: false };
      }
    }
    return { status: INTEGRITY.OK, chars: t.length, brandOk, refusal: false };
  } catch (e) {
    return { status: INTEGRITY.OK, chars: (text || "").length, brandOk: null, refusal: false, error: true };
  }
}
