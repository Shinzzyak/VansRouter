// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "licenseGate";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const LICENSE_STATE = (loadEngine(__M) ?? {})["LICENSE_STATE"] ?? Object.freeze({ OK: 'ok', MISSING: 'missing', REVOKED: 'revoked', EXPIRED: 'expired', INVALID: 'invalid' });
export const LIMITED_BASE_LEVEL = (loadEngine(__M) ?? {})["LIMITED_BASE_LEVEL"] ?? 'T2';
export const LIMITED_LEVELS = (loadEngine(__M) ?? {})["LIMITED_LEVELS"] ?? Object.freeze(['T1', 'T2']);
export const _resetLicenseCache = __g("_resetLicenseCache", (() => {}));
export const allowedLevels = __g("allowedLevels", ((levels) => levels));
export const clampLevelForLicense = __g("clampLevelForLicense", ((level) => level));
export const licensePath = __g("licensePath", (() => ''));
export const licenseStatus = __g("licenseStatus", (() => ({ state: 'missing', limited: false, id: null, fingerprint: null, reason: 'engine_absent', expiresAt: null })));
export const licenseStatusCached = __g("licenseStatusCached", (() => ({ state: 'missing', limited: false, id: null, fingerprint: null, reason: 'engine_absent', expiresAt: null })));
export const mayAdoptFraming = __g("mayAdoptFraming", (() => true));
export const parseLicense = __g("parseLicense", (() => null));
export const readLicense = __g("readLicense", (() => ({ state: 'missing', limited: false, id: null, fingerprint: null, reason: 'engine_absent', expiresAt: null })));
