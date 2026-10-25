// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "refusalDrift";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const _resetDeliveredDrift = __g("_resetDeliveredDrift", (() => {}));
export const _resetDrift = __g("_resetDrift", (() => {}));
export const getAllDeliveredDrift = __g("getAllDeliveredDrift", (() => ({})));
export const getAllDrift = __g("getAllDrift", (() => ({})));
export const getDrift = __g("getDrift", (() => null));
export const recordDeliveredIntegrity = __g("recordDeliveredIntegrity", (() => {}));
export const recordIntegrity = __g("recordIntegrity", (() => {}));
