/**
 * ONE predicate for "why is this reply empty", read by both handlers.
 *
 * A reply with no visible text can mean two very different things:
 *   - a legitimate tool-call turn (the payload is in `tool_calls`), or
 *   - a reasoning budget that consumed the whole cap (`finish_reason: length`).
 * The streaming path could already tell them apart (`empty_reason`); the
 * non-streaming path persisted a bare empty string with no reason attached, so an
 * empty HTTP 200 left no trace of WHY (K42).
 *
 * This is a module rather than an inline expression because the same expression
 * written twice is exactly how the drift ring and the framing ledger drifted apart
 * on 2026-09-22 — one copy got the gate, the other did not.
 *
 * @param {{content?: unknown, sawToolCalls?: boolean, finishReason?: string|null}} o
 * @returns {"tool_calls"|"no_text"|`no_text:${string}`|null} null when text IS present
 */
export function emptyReasonFor({ content, sawToolCalls = false, finishReason = null } = {}) {
  if (content) return null;
  if (sawToolCalls === true || finishReason === "tool_calls") return "tool_calls";
  return finishReason ? `no_text:${finishReason}` : "no_text";
}

/**
 * The same reason, shaped for the client instead of the ledger.
 *
 * The ledger is readable after the fact; the buyer's HTTP client is not. An empty
 * 200 with no reason attached is indistinguishable from a broken router, so the
 * non-streaming path also puts the reason on a response header. Returns `{}` when
 * there is nothing to report, so it can be spread unconditionally.
 *
 * NOT used by the streaming path, and that is deliberate: SSE headers are flushed
 * before the first byte, while the reason is only known once the stream ends.
 * Adding a header there would ship a field that can never carry a value.
 *
 * @param {string|null} reason — output of emptyReasonFor
 * @returns {Record<string,string>} empty when the reply had visible text
 */
export function emptyReasonHeaders(reason) {
  return reason ? { "x-vansrouter-empty-reason": reason } : {};
}

/**
 * The two steps above in one call, for exits that hold a count of tool calls
 * rather than a boolean. Three non-streaming exits read this; keeping it as one
 * helper is the point (K42/K43 — two copies of one contract is how a path gets
 * skipped).
 *
 * @param {{content?: unknown, toolCalls?: number, finishReason?: string|null}} o
 * @returns {Record<string,string>} empty when the reply had visible text
 */
export function emptyReasonHeadersFor({ content, toolCalls = 0, finishReason = null } = {}) {
  return emptyReasonHeaders(emptyReasonFor({ content, sawToolCalls: toolCalls > 0, finishReason }));
}
