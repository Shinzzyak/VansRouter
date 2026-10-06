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
