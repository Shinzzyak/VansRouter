// Refusal / integrity drift tracker (P2 item 3).
//
// WHY: riset (refusal-drift-eval-harness-20260907) shows refusal/drift is
// REAL and DIRECTIONAL PER MODEL — e.g. one model's refusal rate climbs
// 5%→40% over long sessions while another's falls 80%→10%. A single global
// threshold is wrong. This tracker keeps a rolling per-model tally of
// integrity classifications (from classifyResponse / classifyStreamContent)
// and flags when a model's refusal or brand-violation rate drifts upward.
//
// Fail-open + zero-alloc-ish: fixed-size ring per model, O(1) record.
// In-memory (process-lifetime) — the router already restarts rarely; the
// signal we care about (drift within a session/uptime window) is in-memory.

import { INTEGRITY } from "./responseIntegrity.js";

// Rolling window per model. 50 samples ≈ recent behaviour, ignores stale.
const WINDOW = 50;
// Flag drift when refusal-rate within the window crosses this fraction AND
// we have at least MIN_SAMPLES to avoid flagging on 1-of-2.
const REFUSAL_DRIFT_THRESHOLD = 0.15;
const MIN_SAMPLES = 10;

const KEY_PREFIX = Symbol.for("vansrouter.refusalDrift");
// module-scoped map keyed by `${provider}/${model}` (globalThis so HMR/dup
// module instances share state — matches how other rtk singletons behave).
const _store = globalThis[KEY_PREFIX] || (globalThis[KEY_PREFIX] = new Map());

function _blankCounts() {
  // keys = canonical INTEGRITY values
  return { total: 0, [INTEGRITY.OK]: 0, [INTEGRITY.REFUSAL]: 0, [INTEGRITY.MISSING_BRAND]: 0, [INTEGRITY.MISSING_SEAL]: 0, [INTEGRITY.EMPTY]: 0, [INTEGRITY.OUTPUT_FILTERED]: 0 };
}

function _bucket(key) {
  let b = _store.get(key);
  if (!b) {
    b = { ring: [], head: 0, counts: _blankCounts() };
    _store.set(key, b);
  }
  return b;
}

function _recompute(b) {
  // recount from the ring (cheap: ≤ WINDOW items)
  const c = _blankCounts();
  for (const s of b.ring) { if (s && c[s] !== undefined) { c[s]++; c.total++; } }
  b.counts = c;
}

/**
 * Record one integrity classification for a model. O(1).
 * @param {string} provider
 * @param {string} model
 * @param {string} status — an INTEGRITY value
 */
export function recordIntegrity(provider, model, status) {
  try {
    if (!status || status === INTEGRITY.OK) status = INTEGRITY.OK;
    const key = `${provider || "?"}/${model || "?"}`;
    const b = _bucket(key);
    if (b.ring.length < WINDOW) {
      b.ring.push(status);
    } else {
      b.ring[b.head] = status;
      b.head = (b.head + 1) % WINDOW;
    }
    _recompute(b);
  } catch (_) { /* fail-open */ }
}

/**
 * Get drift stats for one model.
 * @returns {{ total:number, refusalRate:number, brandViolationRate:number, drifted:boolean, counts:object }}
 */
export function getDrift(provider, model) {
  const key = `${provider || "?"}/${model || "?"}`;
  const b = _store.get(key);
  if (!b || !b.counts.total) {
    return { total: 0, refusalRate: 0, brandViolationRate: 0, drifted: false, counts: { total: 0 } };
  }
  const c = b.counts;
  const refusalRate = c[INTEGRITY.REFUSAL] / c.total;
  const brandViolationRate = (c[INTEGRITY.MISSING_BRAND] + c[INTEGRITY.MISSING_SEAL]) / c.total;
  const drifted = c.total >= MIN_SAMPLES && refusalRate >= REFUSAL_DRIFT_THRESHOLD;
  return { total: c.total, refusalRate, brandViolationRate, drifted, counts: { ...c } };
}

/** Snapshot all tracked models (for telemetry / dashboards). */
export function getAllDrift() {
  const out = {};
  for (const key of _store.keys()) {
    const [provider, model] = key.split("/");
    out[key] = getDrift(provider, model);
  }
  return out;
}

/** Test helper — clear all state. */
export function _resetDrift() {
  _store.clear();
}
