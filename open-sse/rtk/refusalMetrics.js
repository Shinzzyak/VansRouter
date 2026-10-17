// Refusal counter — the instrument the 2026-10-17 audit found missing.
//
// Why this exists: 18,028 assistant messages in the default profile's state.db
// contained ZERO refusal-shaped text. Not because refusals never happen, but
// because nothing counted them. A refusal that bypassEngine escalates into a
// real answer leaves no trace: the caller sees the good answer, the log sees an
// "escalation successful" line, and the refusal itself is gone. That is why
// "it sometimes refuses" stayed unfalsifiable for weeks.
//
// Three counters, one per stage of the same journey:
//   detected — the classifier saw a refusal-shaped body from upstream
//   retried  — an escalation attempt was made because of it
//   shipped  — every attempt failed and the refusal reached the client
//
// ponytail: /tmp jsonl + process memory, session-scoped diagnostics. Move to
// sqlite if these ever need to survive a restart.
import { appendFileSync } from "node:fs";

const FILE = process.env.VR_REFUSAL_METRICS || "/tmp/vansrouter-refusal-metrics.jsonl";
const counters = { detected: 0, retried: 0, shipped: 0 };

/**
 * @param {"detected"|"retried"|"shipped"} kind
 * @param {object|null} meta  provider/model/reason — never prompt or answer text
 */
export function recordRefusalMetric(kind, meta = null) {
  if (!(kind in counters)) return;
  counters[kind] += 1;
  try {
    appendFileSync(FILE, `${JSON.stringify({ t: new Date().toISOString(), kind, ...(meta || {}) })}\n`);
  } catch {
    // Diagnostics must never break a request.
  }
}

export function getRefusalMetrics() {
  return { ...counters, file: FILE };
}

export function _resetRefusalMetrics() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}
