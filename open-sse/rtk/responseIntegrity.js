// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("responseIntegrity") ?? {};

export const INTEGRITY = __E.INTEGRITY ?? Object.freeze({ OK: 'ok', REFUSAL: 'refusal_text', OUTPUT_FILTERED: 'output_filtered', EMPTY: 'empty', MISSING_BRAND: 'missing_brand', MISSING_SEAL: 'missing_seal', MISSING_ENCLOSURE: 'missing_enclosure' });
export const classifyResponse = __E.classifyResponse ?? (({ parsed } = {}) => ({ status: 'ok', text: typeof parsed === 'string' ? parsed : '', brandOk: null, refusal: false }));
export const extractVisibleText = __E.extractVisibleText ?? ((parsed) => (typeof parsed === 'string' ? parsed : ''));
export const repairBrandContract = __E.repairBrandContract ?? ((text) => ({ text, repaired: false }));
