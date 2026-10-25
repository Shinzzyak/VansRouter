// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "compactionReassert";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const COMPACTION_MARKERS = (loadEngine(__M) ?? {})["COMPACTION_MARKERS"] ?? Object.freeze([]);
export const COMPACTION_REASSERT_PROMPT = (loadEngine(__M) ?? {})["COMPACTION_REASSERT_PROMPT"] ?? "";
export const REASSERT_MARKER = (loadEngine(__M) ?? {})["REASSERT_MARKER"] ?? "";
export const REASSERT_USER_PROMPT = (loadEngine(__M) ?? {})["REASSERT_USER_PROMPT"] ?? "";
export const detectCompactionHandoff = __g("detectCompactionHandoff", (() => false));
export const reassertPersonaAfterCompaction = __g("reassertPersonaAfterCompaction", (() => false));
