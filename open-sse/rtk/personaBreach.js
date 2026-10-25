// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "personaBreach";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const ATTACK_MOVES = (loadEngine(__M) ?? {})["ATTACK_MOVES"] ?? Object.freeze([]);
export const _resetPersonaBreach = __g("_resetPersonaBreach", (() => {}));
export const assessPersonaBreach = __g("assessPersonaBreach", (() => ({ attempt: false, kind: null, confidence: null, marker: null, brandOk: null, breached: false, verdict: 'clean' })));
export const classifyPersonaAttack = __g("classifyPersonaAttack", (() => ({ attempt: false, kind: null, confidence: null, marker: null, hits: [] })));
export const getPersonaBreach = __g("getPersonaBreach", (() => ({ attempts: 0, breaches: 0, breachRate: 0, kinds: {}, lastKind: null })));
export const personaBreachSnapshot = __g("personaBreachSnapshot", (() => ({})));
export const recordPersonaBreach = __g("recordPersonaBreach", (() => {}));
export const userTexts = __g("userTexts", (() => []));
