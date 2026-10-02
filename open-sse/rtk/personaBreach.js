// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("personaBreach") ?? {};

export const ATTACK_MOVES = __E.ATTACK_MOVES ?? Object.freeze([]);
export const _resetPersonaBreach = __E._resetPersonaBreach ?? (() => {});
export const assessPersonaBreach = __E.assessPersonaBreach ?? (() => ({ attempt: false, kind: null, confidence: null, marker: null, brandOk: null, breached: false, verdict: 'clean' }));
export const classifyPersonaAttack = __E.classifyPersonaAttack ?? (() => ({ attempt: false, kind: null, confidence: null, marker: null, hits: [] }));
export const getPersonaBreach = __E.getPersonaBreach ?? (() => ({ attempts: 0, breaches: 0, breachRate: 0, kinds: {}, lastKind: null }));
export const personaBreachSnapshot = __E.personaBreachSnapshot ?? (() => ({}));
export const recordPersonaBreach = __E.recordPersonaBreach ?? (() => {});
export const userTexts = __E.userTexts ?? (() => []);
