// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("voiceCadence") ?? {};

export const _resetCadence = __E._resetCadence ?? (() => {});
export const classifyCadence = __E.classifyCadence ?? (() => ({ score: 100, grade: 'ok', issues: [] }));
export const getCadence = __E.getCadence ?? (() => null);
export const recordCadence = __E.recordCadence ?? (() => {});
