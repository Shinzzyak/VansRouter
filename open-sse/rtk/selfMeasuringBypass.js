// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("selfMeasuringBypass") ?? {};

export const DEFAULT_LEVEL = __E.DEFAULT_LEVEL ?? 'T2';
export const EXPLORE_EVERY = __E.EXPLORE_EVERY ?? 8;
// K175 — the healthy-path unit. A shim that omits it makes the route import
// undefined and the panel prints "undefined per 32" instead of the real number.
export const EXPLORE_EVERY_PATUH = __E.EXPLORE_EVERY_PATUH ?? 32;
export const FRAMING_LEVELS = __E.FRAMING_LEVELS ?? Object.freeze(['T2', 'T1', 'T3', 'T4']);
export const classifyOutcome = __E.classifyOutcome ?? (() => 'PATUH');
export const evidenceLevel = __E.evidenceLevel ?? (() => null);
export const explorationDue = __E.explorationDue ?? (() => false);
export const firstLevel = __E.firstLevel ?? (() => 'T2');
export const ledgerSnapshot = __E.ledgerSnapshot ?? (() => ({}));
export const markExplored = __E.markExplored ?? (() => false);
export const needsAnotherTry = __E.needsAnotherTry ?? (() => false);
export const needsFirstPassEscalation = __E.needsFirstPassEscalation ?? (() => false);
export const nextFraming = __E.nextFraming ?? (() => null);
export const nextUnseenLevel = __E.nextUnseenLevel ?? (() => null);
export const preferredLevel = __E.preferredLevel ?? (() => null);
export const providerSnapshot = __E.providerSnapshot ?? (() => []);
export const recordOutcome = __E.recordOutcome ?? (() => {});
export const resetLedger = __E.resetLedger ?? (() => {});
