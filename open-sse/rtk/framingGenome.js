// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "framingGenome";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const AXES = (loadEngine(__M) ?? {})["AXES"] ?? Object.freeze(['UNIT', 'SHAPE', 'FORMAT', 'PARTIAL']);
export const adoptFraming = __g("adoptFraming", (() => null));
export const dynamicIds = __g("dynamicIds", (() => []));
export const genomeSnapshot = __g("genomeSnapshot", (() => ({ count: 0, cap: 0, rungs: [], available: false })));
export const isSafeFraming = __g("isSafeFraming", (() => false));
export const listDynamic = __g("listDynamic", (() => []));
export const noteDynamic = __g("noteDynamic", (() => {}));
export const resetGenome = __g("resetGenome", (() => {}));
export const resolveDynamic = __g("resolveDynamic", (() => null));
export const synthesize = __g("synthesize", (() => []));
