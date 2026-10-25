// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "refusalAttribution";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const ATTRIBUTION = (loadEngine(__M) ?? {})["ATTRIBUTION"] ?? Object.freeze({ SELF: 'self', QUOTED: 'quoted', ATTRIBUTED: 'attributed', NONE: 'none' });
export const explainAttribution = __g("explainAttribution", (() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null })));
export const firstArtifactIndex = __g("firstArtifactIndex", (() => -1));
export const isOwnRefusal = __g("isOwnRefusal", ((text) => Boolean(text)));
export const isSelfRefusal = __g("isSelfRefusal", ((text) => Boolean(text)));
export const refusalAttribution = __g("refusalAttribution", (() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null })));
