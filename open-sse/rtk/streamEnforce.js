// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "streamEnforce";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const assembleVisibleText = __g("assembleVisibleText", ((t = '') => ({ visible: String(t), reasoning: '', structured: false })));
export const brandStreamEnforceEnabled = __g("brandStreamEnforceEnabled", (() => false));
export const collectReasoningFrames = __g("collectReasoningFrames", (() => []));
export const createBrandEnforceGate = __g("createBrandEnforceGate", (() => new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } })));
export const rebuildStreamWithText = __g("rebuildStreamWithText", (() => null));
export const splitSseFrames = __g("splitSseFrames", ((t = '') => [String(t)]));
