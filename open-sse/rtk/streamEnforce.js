// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("streamEnforce") ?? {};

export const assembleVisibleText = __E.assembleVisibleText ?? ((t = '') => ({ visible: String(t), structured: false }));
export const brandStreamEnforceEnabled = __E.brandStreamEnforceEnabled ?? (() => false);
export const createBrandEnforceGate = __E.createBrandEnforceGate ?? (() => new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } }));
export const rebuildStreamWithText = __E.rebuildStreamWithText ?? (() => null);
