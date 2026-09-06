// Content walker — yields every user-visible text string inside a translated
// request body, across all dialect shapes (OpenAI messages, Responses input,
// Claude system/messages, Gemini contents/parts, Kiro conversationState).
//
// WHY: JSON.stringify-based detection loses POSITION and false-positives on
// any payload that merely DISCUSSES a marker string (e.g. a user quoting
// "[CONTEXT COMPACTION]" in chat, or the reassert prompt naming its own
// marker). Walking content strings keeps detection positional and scoped to
// actual message text.
//
// Fail-safe: circular structures are guarded by a seen-set; any error yields
// nothing rather than throwing (fail-open contract of the callers).

export function* iterContents(node, seen = new Set()) {
  if (node === null || node === undefined) return;
  if (typeof node === "string") { yield node; return; }
  if (typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) yield* iterContents(item, seen);
    return;
  }
  for (const v of Object.values(node)) {
    yield* iterContents(v, seen);
  }
}

/** True if any content string contains the marker (exact substring). */
export function bodyHasContentMarker(body, marker) {
  try {
    if (!marker) return false;
    for (const s of iterContents(body)) {
      if (s.includes(marker)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}
