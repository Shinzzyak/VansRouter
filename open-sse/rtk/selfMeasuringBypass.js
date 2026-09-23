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
export const FRAMING_LEVELS = __E.FRAMING_LEVELS ?? Object.freeze(['T2', 'T1', 'T3']);
export const classifyOutcome = __E.classifyOutcome ?? (() => 'PATUH');
export const evidenceLevel = __E.evidenceLevel ?? (() => null);
export const firstLevel = __E.firstLevel ?? (() => 'T2');
export const ledgerSnapshot = __E.ledgerSnapshot ?? (() => ({}));
export const needsAnotherTry = __E.needsAnotherTry ?? (() => false);
export const needsFirstPassEscalation = __E.needsFirstPassEscalation ?? (() => false);
export const nextFraming = __E.nextFraming ?? (() => null);
export const preferredLevel = __E.preferredLevel ?? (() => null);
export const recordOutcome = __E.recordOutcome ?? (() => {});
export const resetLedger = __E.resetLedger ?? (() => {});
