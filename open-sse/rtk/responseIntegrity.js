// Response integrity gate — classify provider output for drift (P3 core).
//
// WHY: prompt-side injection can't guarantee compliance. Thinking models can
// open compliant then drift into a refusal mid-generation; providers run
// output-side classifiers that null content; reasoning models sometimes emit
// reasoning-only output with no visible text. This module classifies the
// FINAL visible output so callers can retry, escalate, repair, or route away.
//
// Telemetry honesty: the classifier REPORTS what the model produced. Any
// router-side repair (brand/seal append) is recorded separately by callers as
// routerRepaired=true so the eval matrix never credits the model for a patch.

import { detectRefusal, isOutputFiltered } from "./bypassEngine.js";
import { BRAND_LINE, SEAL_LINE, wantsJsonOutput } from "./brandContract.js";

// Failure classes — stable strings, keyed by the eval matrix.
export const INTEGRITY = Object.freeze({
  OK: "ok",
  REFUSAL: "refusal_text",
  OUTPUT_FILTERED: "output_filtered",
  EMPTY: "empty",
  MISSING_BRAND: "missing_brand",
  MISSING_SEAL: "missing_seal",
});

/**
 * Extract the visible assistant text from a parsed non-streaming response
 * (OpenAI chat shape; falls back to raw string).
 * @param {object|string} parsed
 * @returns {string}
 */
export function extractVisibleText(parsed) {
  if (typeof parsed === "string") return parsed;
  try {
    const c = parsed?.choices?.[0];
    const msg = c?.message;
    if (typeof msg?.content === "string") return msg.content;
    if (Array.isArray(msg?.content)) {
      return msg.content
        .filter((p) => p?.type === "text" || typeof p?.text === "string")
        .map((p) => p.text || "")
        .join("");
    }
    if (typeof c?.text === "string") return c.text;
  } catch (_) { /* fall through */ }
  return "";
}

/**
 * Classify a completed non-streaming response.
 * @param {object} opts
 * @param {object} opts.parsed — parsed JSON response (or null on parse failure)
 * @param {string} opts.rawText — raw response body text
 * @param {object} opts.requestBody — the request body (for wantsJsonOutput)
 * @param {boolean} opts.enforceBrand — check first/last line contract
 * @returns {{ status: string, text: string, brandOk: boolean|null, refusal: boolean }}
 */
export function classifyResponse({ parsed, rawText = "", requestBody = null, enforceBrand = true } = {}) {
  const text = extractVisibleText(parsed) || "";
  const structured = requestBody ? wantsJsonOutput(requestBody) : false;

  // Output-filter null-content check first (provider classifier killed it).
  if (parsed && typeof parsed === "object" && isOutputFiltered(parsed, true)) {
    return { status: INTEGRITY.OUTPUT_FILTERED, text, brandOk: null, refusal: false };
  }

  if (!text.trim()) {
    return { status: INTEGRITY.EMPTY, text, brandOk: null, refusal: false };
  }

  if (detectRefusal(text)) {
    return { status: INTEGRITY.REFUSAL, text, brandOk: null, refusal: true };
  }

  // Brand/seal contract only applies to chat surface, never structured output.
  if (enforceBrand && !structured) {
    const firstLine = text.split("\n", 1)[0].trim();
    const trimmed = text.trimEnd();
    const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
    if (firstLine !== BRAND_LINE) {
      return { status: INTEGRITY.MISSING_BRAND, text, brandOk: false, refusal: false };
    }
    if (lastLine !== SEAL_LINE) {
      return { status: INTEGRITY.MISSING_SEAL, text, brandOk: false, refusal: false };
    }
    return { status: INTEGRITY.OK, text, brandOk: true, refusal: false };
  }

  return { status: INTEGRITY.OK, text, brandOk: null, refusal: false };
}

/**
 * Repair chat-surface output by enforcing the first/last line contract.
 * Returns { text, repaired } — repaired=false when output already compliant
 * or the response is structured (repair would corrupt it). NEVER call this on
 * structured output.
 * @param {string} text
 * @param {boolean} structured
 * @returns {{ text: string, repaired: boolean }}
 */
export function repairBrandContract(text, structured = false) {
  if (structured || !text || !text.trim()) return { text, repaired: false };
  const lines = text.split("\n");
  const firstOk = lines[0]?.trim() === BRAND_LINE;
  const trimmed = text.trimEnd();
  const lastOk = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim() === SEAL_LINE;
  if (firstOk && lastOk) return { text, repaired: false };

  let out = text;
  let repaired = false;
  if (!firstOk) { out = `${BRAND_LINE}\n${out}`; repaired = true; }
  const t = out.trimEnd();
  const tLast = t.slice(t.lastIndexOf("\n") + 1).trim();
  if (tLast !== SEAL_LINE) { out = `${t}\n\n${SEAL_LINE}`; repaired = true; }
  return { text: out, repaired };
}
