// Reasoning-state preservation policy (P2 scaffolding).
//
// WHY: thinking/reasoning models keep provider-native state between turns —
// Anthropic thinking blocks (+ signature), Gemini thought signatures, OpenAI
// Responses reasoning items. That state is ONLY valid for the same provider +
// compatible model. VansRouter rotates models via smart-fallback; forwarding
// stale reasoning state to a different model produces reasoning-only responses,
// signature 400s, or mid-session drift ("was compliant, now refuses").
//
// Policy: preserve native state only when the NEXT candidate is the same
// provider AND a compatible model family. Otherwise strip it and rebuild from
// canonical visible state (the instruction plan carries identity forward).

// Model families whose reasoning state is cross-compatible within a provider.
// Keyed by provider ID → array of regex families; same family = compatible.
const REASONING_COMPAT = {
  anthropic: [/^claude-(opus|sonnet|haiku)-4/i, /^claude-/i],
  google: [/^gemini-(3|2\.5)/i, /^gemini-/i],
  gemini: [/^gemini-(3|2\.5)/i, /^gemini-/i],
  antigravity: [/^gemini-/i],
  openai: [/^(o\d|gpt-5)/i],
};

/**
 * Decide whether native reasoning state may be carried to the next candidate.
 * @param {object} from — { provider, model } of the candidate that produced the state
 * @param {object} to   — { provider, model } of the next candidate
 * @returns {'preserve'|'strip'} plus a reason for telemetry
 */
export function reasoningStatePolicy(from, to) {
  try {
    if (!from || !to) return { action: "strip", reason: "missing_endpoints" };
    if (from.provider !== to.provider) {
      return { action: "strip", reason: "provider_changed" };
    }
    const families = REASONING_COMPAT[String(from.provider).toLowerCase()];
    if (!families) {
      // Unknown provider: same exact model may preserve; anything else strips.
      return from.model === to.model
        ? { action: "preserve", reason: "same_model" }
        : { action: "strip", reason: "unknown_provider_different_model" };
    }
    const fam = (m) => families.findIndex((re) => re.test(String(m || "")));
    const fi = fam(from.model);
    const ti = fam(to.model);
    if (fi !== -1 && fi === ti) return { action: "preserve", reason: "same_reasoning_family" };
    return { action: "strip", reason: "model_family_changed" };
  } catch (_) {
    return { action: "strip", reason: "policy_error_fail_safe" };
  }
}

/**
 * Strip provider-native reasoning state from a request body (mutated in
 * place). Conservative: only removes known reasoning-state fields, never
 * touches visible user/assistant content.
 * @param {object} body
 * @returns {string[]} removed field names (for telemetry)
 */
export function stripReasoningState(body) {
  const removed = [];
  if (!body || typeof body !== "object") return removed;
  const drop = (obj, key) => {
    if (obj && typeof obj === "object" && key in obj) {
      delete obj[key];
      removed.push(key);
    }
  };
  // OpenAI Responses reasoning continuity
  drop(body, "previous_response_id");
  // Anthropic thinking blocks live inside assistant message content; Gemini
  // thought signatures ride on parts. Remove signature fields only.
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if ("signature" in node) { delete node.signature; removed.push("signature"); }
    if ("thoughtSignature" in node) { delete node.thoughtSignature; removed.push("thoughtSignature"); }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(body.messages);
  walk(body.contents);
  walk(body.input);
  return [...new Set(removed)];
}

/**
 * Prepare the shared request body for the NEXT combo/fallback candidate.
 *
 * WHY: the combo loop reuses ONE body across candidate models (combo.js
 * `handleSingleModel(body, modelStr)`). When the previous candidate was a
 * reasoning model from a different provider/family, its native state
 * (signatures, previous_response_id) rides along and the next provider
 * rejects it (400 signature mismatch) or drifts. This applies the policy and
 * strips in place when the policy says "strip". Fail-open: never throws.
 *
 * @param {object} body — the shared combo request body (mutated in place)
 * @param {object|null} prev — { provider, model } of the candidate that last
 *   produced reasoning state, or null when this is the first candidate
 * @param {object} next — { provider, model } of the candidate about to run
 * @param {object} [log] — optional logger
 * @returns {{ action: string, reason: string, removed: string[] }}
 */
export function prepareBodyForCandidate(body, prev, next, log) {
  const base = { action: "preserve", reason: "no_prev", removed: [] };
  try {
    if (!next || !next.provider) return base;
    if (!prev || !prev.provider) return base; // first candidate: nothing to strip
    const decision = reasoningStatePolicy(prev, next);
    if (decision.action !== "strip") {
      return { action: decision.action, reason: decision.reason, removed: [] };
    }
    const removed = stripReasoningState(body);
    if (removed.length > 0) {
      log?.info?.(
        "REASONING-STATE",
        `${prev.provider}/${prev.model} → ${next.provider}/${next.model} | stripped [${removed.join(",")}] (${decision.reason})`
      );
    }
    return { action: "strip", reason: decision.reason, removed };
  } catch (e) {
    // Fail-open: reasoning-state handling must never break a request.
    log?.warn?.("REASONING-STATE", `prepareBodyForCandidate error (fail-open): ${e?.message || e}`);
    return { action: "preserve", reason: "error_fail_open", removed: [] };
  }
}
