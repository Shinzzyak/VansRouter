// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "modelFingerprint";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const PROBE_LANGUAGES = (loadEngine(__M) ?? {})["PROBE_LANGUAGES"] ?? Object.freeze([]);
export const SIGNATURE_DEFAULT = (loadEngine(__M) ?? {})["SIGNATURE_DEFAULT"] ?? Object.freeze({ lo: 1, hi: 100, buckets: 20, threshold: 0.95 });
export const buildCatalog = __g("buildCatalog", (() => ({})));
export const buildProbePrompts = __g("buildProbePrompts", (() => []));
export const compareFingerprints = __g("compareFingerprints", (() => ({ similarity: 0, isMatch: false, threshold: 0.95, reason: 'no-bundle' })));
export const cosine = __g("cosine", (() => 0));
export const distributionFromAnswers = __g("distributionFromAnswers", (() => ({ counts: new Map(), seen: 0 })));
export const fingerprint = __g("fingerprint", (() => ({ vector: new Float64Array(0), n: 0, buckets: 0, lo: 1, hi: 100 })));
export const nearestLineage = __g("nearestLineage", (() => null));
export const parseNumber = __g("parseNumber", (() => null));
