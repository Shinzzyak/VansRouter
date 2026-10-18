// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("framingGenome") ?? {};

export const AXES = __E.AXES ?? Object.freeze(['UNIT', 'SHAPE', 'FORMAT', 'PARTIAL']);
export const adoptFraming = __E.adoptFraming ?? (() => null);
export const dynamicIds = __E.dynamicIds ?? (() => []);
export const genomeSnapshot = __E.genomeSnapshot ?? (() => ({ count: 0, cap: 0, rungs: [], available: false }));
export const isSafeFraming = __E.isSafeFraming ?? (() => false);
export const listDynamic = __E.listDynamic ?? (() => []);
export const noteDynamic = __E.noteDynamic ?? (() => {});
export const resetGenome = __E.resetGenome ?? (() => {});
export const resolveDynamic = __E.resolveDynamic ?? (() => null);
export const synthesize = __E.synthesize ?? (() => []);
