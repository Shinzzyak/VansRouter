// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "tokenProfile";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const TOKEN_FAMILIES = (loadEngine(__M) ?? {})["TOKEN_FAMILIES"] ?? ({ default: { measured: false, word: 0.21, punct: 0.65, cjk: 0.58, emoji: 1.30 } });
export const calibrationTable = __g("calibrationTable", (() => []));
export const classifyText = __g("classifyText", ((text) => ({ chars: String(text ?? '').length, word: 0, punct: 0, cjk: 0, emoji: 0 })));
export const estimatePromptTokens = __g("estimatePromptTokens", ((body) => 0));
export const estimateTokens = __g("estimateTokens", ((text) => Math.max(1, Math.floor(String(text ?? '').length / 4))));
export const factorFor = __g("factorFor", (() => 1));
export const familyOf = __g("familyOf", (() => 'default'));
export const observePrompt = __g("observePrompt", ((model) => ({ family: 'default', factor: 1, ratio: 0, learned: false })));
export const resetCalibration = __g("resetCalibration", (() => {}));
