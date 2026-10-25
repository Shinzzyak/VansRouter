// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "watermark";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const WATERMARK = (loadEngine(__M) ?? {})["WATERMARK"] ?? Object.freeze({ VERSION: 'vrw1', LICENCE_HEADER: 'x-vans-router-licence', PROOF_HEADER: 'x-vans-router-watermark' });
export const licenceProof = __g("licenceProof", (() => null));
export const maskLicenceId = __g("maskLicenceId", (() => null));
export const verifyWatermark = __g("verifyWatermark", (() => false));
export const watermarkHeaders = __g("watermarkHeaders", (() => ({})));
