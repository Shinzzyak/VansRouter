// Compression analytics sink for the token savers (RTK, headroom).
//
// Pure module on purpose: open-sse runs inside the Next.js proxy process AND is
// bundled for the standalone engine build, so it must not reach into the DB
// layer. Events land in a bounded in-memory ring; the dashboard route drains it
// and folds the events into bounded aggregates in the kv table
// (src/lib/db/repos/compressionAnalyticsRepo.js).

// ponytail: single in-process ring, 5000 events. If a deployment ever runs the
// proxy in a separate process from the dashboard, drain needs to move to a
// shared store (kv write per batch) instead.
const MAX_BUFFERED_EVENTS = 5000;

const buffer = [];

// The proxy only ever sees byte counts, never a real tokenizer. 4 bytes/token
// is the usual English/code ratio; every number derived from it is an estimate.
export const BYTES_PER_TOKEN = 4;

export function recordCompressionEvent(event) {
  if (!event || !event.mode) return;
  if (buffer.length >= MAX_BUFFERED_EVENTS) buffer.shift();
  buffer.push({ timestamp: new Date().toISOString(), ...event });
}

export function drainCompressionEvents() {
  return buffer.splice(0, buffer.length);
}

export function bufferedEventCount() {
  return buffer.length;
}

// RTK reports bytesBefore/bytesAfter; headroom reports token counts already.
export function toTokenDelta({ bytesBefore = 0, bytesAfter = 0, originalTokens, compressedTokens }) {
  if (Number.isFinite(originalTokens)) {
    const original = Math.max(0, Math.round(originalTokens));
    const compressed = Math.max(0, Math.round(compressedTokens ?? original));
    return { originalTokens: original, compressedTokens: compressed, tokensSaved: Math.max(0, original - compressed) };
  }
  const original = Math.max(0, Math.round(bytesBefore / BYTES_PER_TOKEN));
  const compressed = Math.max(0, Math.round(bytesAfter / BYTES_PER_TOKEN));
  return { originalTokens: original, compressedTokens: compressed, tokensSaved: Math.max(0, original - compressed) };
}
