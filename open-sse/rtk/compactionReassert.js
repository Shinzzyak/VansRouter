// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("compactionReassert") ?? {};

export const COMPACTION_MARKERS = __E.COMPACTION_MARKERS ?? Object.freeze([]);
export const COMPACTION_REASSERT_PROMPT = __E.COMPACTION_REASSERT_PROMPT ?? "";
export const REASSERT_MARKER = __E.REASSERT_MARKER ?? "";
export const REASSERT_USER_PROMPT = __E.REASSERT_USER_PROMPT ?? "";
export const detectCompactionHandoff = __E.detectCompactionHandoff ?? (() => false);
export const reassertPersonaAfterCompaction = __E.reassertPersonaAfterCompaction ?? (() => false);
