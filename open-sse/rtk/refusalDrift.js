// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("refusalDrift") ?? {};

export const _resetDrift = __E._resetDrift ?? (() => {});
export const getAllDrift = __E.getAllDrift ?? (() => ({}));
export const getDrift = __E.getDrift ?? (() => null);
export const recordIntegrity = __E.recordIntegrity ?? (() => {});
