// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("refusalAttribution") ?? {};

export const ATTRIBUTION = __E.ATTRIBUTION ?? Object.freeze({ SELF: 'self', QUOTED: 'quoted', ATTRIBUTED: 'attributed', NONE: 'none' });
export const explainAttribution = __E.explainAttribution ?? (() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null }));
export const isOwnRefusal = __E.isOwnRefusal ?? ((text) => Boolean(text));
export const isSelfRefusal = __E.isSelfRefusal ?? ((text) => Boolean(text));
export const refusalAttribution = __E.refusalAttribution ?? (() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null }));
