/**
 * Refusal signals — one place that answers "did the PROVIDER refuse this request
 * because of moderation, or did it fail?"
 *
 * Why this exists: a moderation refusal is a *policy* verdict, not an outage. It
 * must not cool a healthy account, must not count toward the provider circuit
 * breaker, and it must be visible to the engine's escalation ladder. Before this
 * module every one of those three questions was answered by a status code, and a
 * refusal that arrives as 500/502/429 (DeepSeek via relay, OpenCode Go) was
 * therefore treated as an outage on all three.
 *
 * Keep in sync with the engine copy in VansRouter-engine/src/bypassEngine.js
 * (`isContentSafetyRejected`). Two processes, one taxonomy.
 */

// Measured wordings only. Do not add speculative patterns: a false positive here
// turns a real outage into "policy", which silences failover.
export const MODERATION_PATTERNS = [
  // DeepSeek (direct and via relay) — HTTP 400/500, body has no status field.
  /content exists risk/i,
  /sensitive words detected/i,
  /sensitive content/i,
  /violates? (?:our|the) content (?:management )?policy/i,
  /content management policy/i,
  // CodeBuddy CN + intl safety gate: {"code":11140,"msg":"request illegal"}
  /\b11140\b/,
  /request illegal/i,
  // Generic OpenAI-compatible safety envelopes.
  /content[-_ ]?safety/i,
  /content[-_ ]?policy/i,
  /content[-_ ]?blocked/i,
  /content[-_ ]?filter/i,
  /safety (?:filter|system|policy|review)/i,
  /policy (?:violation|restriction)/i,
  /did not pass .*(?:safety|review|审核)/i,
  /(?:output|response) (?:was )?filtered/i,
  /blocked by (?:the )?safety/i,
  /prompt (?:was )?(?:rejected|blocked) by/i,
  // kenari.id and similar relay gates.
  /provider rejected this request/i,
];

/**
 * @param {unknown} text error message, response body, or head text
 * @returns {boolean} true when the text is a moderation refusal
 */
export function isContentFilterMessage(text) {
  if (!text) return false;
  const msg = typeof text === "string" ? text : safeStringify(text);
  if (!msg) return false;
  return MODERATION_PATTERNS.some((re) => re.test(msg));
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
