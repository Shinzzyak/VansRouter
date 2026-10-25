// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "selfMeasuringBypass";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const DEFAULT_LEVEL = (loadEngine(__M) ?? {})["DEFAULT_LEVEL"] ?? 'T2';
export const EXPLORE_EVERY = (loadEngine(__M) ?? {})["EXPLORE_EVERY"] ?? 8;
export const EXPLORE_EVERY_PATUH = (loadEngine(__M) ?? {})["EXPLORE_EVERY_PATUH"] ?? 32;
export const FRAMING_LEVELS = (loadEngine(__M) ?? {})["FRAMING_LEVELS"] ?? Object.freeze(['T2', 'T1', 'T3', 'T4']);
export const acceptedClass = __g("acceptedClass", ((level, kelas) => kelas));
export const classifyOutcome = __g("classifyOutcome", (() => 'PATUH'));
export const escalationClass = __g("escalationClass", ((level, kelas) => kelas));
export const evidenceLevel = __g("evidenceLevel", (() => null));
export const explorationDue = __g("explorationDue", (() => false));
export const firstLevel = __g("firstLevel", (() => 'T2'));
export const ledgerSnapshot = __g("ledgerSnapshot", (() => ({})));
export const markExplored = __g("markExplored", (() => false));
export const needsAnotherTry = __g("needsAnotherTry", (() => false));
export const needsFirstPassEscalation = __g("needsFirstPassEscalation", (() => false));
export const needsMoreEscalation = __g("needsMoreEscalation", (() => false));
export const nextFraming = __g("nextFraming", (() => null));
export const nextUnseenLevel = __g("nextUnseenLevel", (() => null));
export const preferredLevel = __g("preferredLevel", (() => null));
export const providerSnapshot = __g("providerSnapshot", (() => []));
export const recordCompliant = __g("recordCompliant", (() => {}));
export const recordOutcome = __g("recordOutcome", (() => {}));
export const resetLedger = __g("resetLedger", (() => {}));
