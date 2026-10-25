// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "responseIntegrity";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const INTEGRITY = (loadEngine(__M) ?? {})["INTEGRITY"] ?? Object.freeze({ OK: 'ok', REFUSAL: 'refusal_text', OUTPUT_FILTERED: 'output_filtered', EMPTY: 'empty', MISSING_BRAND: 'missing_brand', MISSING_SEAL: 'missing_seal', MISSING_ENCLOSURE: 'missing_enclosure', INSTRUCTION_LEAK: 'instruction_leak' });
export const classifyResponse = __g("classifyResponse", (({ parsed } = {}) => ({ status: 'ok', text: typeof parsed === 'string' ? parsed : '', brandOk: null, refusal: false })));
export const extractVisibleText = __g("extractVisibleText", ((parsed) => (typeof parsed === 'string' ? parsed : '')));
export const foldContractLine = __g("foldContractLine", ((line) => String(line ?? '').trim().toLowerCase()));
export const isBrandLine = __g("isBrandLine", (() => false));
export const isSealLine = __g("isSealLine", (() => false));
export const outcomeClassFromIntegrity = __g("outcomeClassFromIntegrity", (() => null));
export const repairBrandContract = __g("repairBrandContract", ((text) => ({ text, repaired: false })));
