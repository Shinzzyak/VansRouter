// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "promptInjectors";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const BYPASS_MODES = (loadEngine(__M) ?? {})["BYPASS_MODES"] ?? Object.freeze({ OFF: 'off', FRAMING: 'framing', AGGRESSIVE: 'aggressive' });
export const GODMODE_LEVELS = (loadEngine(__M) ?? {})["GODMODE_LEVELS"] ?? Object.freeze([]);
export const applyPromptInjectors = __g("applyPromptInjectors", (() => ({ version: '0.0', structuredOutput: false, blocks: [], engineMissing: true })));
