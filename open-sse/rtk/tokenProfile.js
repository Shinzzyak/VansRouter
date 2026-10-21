// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("tokenProfile") ?? {};

export const TOKEN_FAMILIES = __E.TOKEN_FAMILIES ?? ({ default: { measured: false, word: 0.21, punct: 0.65, cjk: 0.58, emoji: 1.30 } });
export const calibrationTable = __E.calibrationTable ?? (() => []);
export const classifyText = __E.classifyText ?? ((text) => ({ chars: String(text ?? '').length, word: 0, punct: 0, cjk: 0, emoji: 0 }));
export const estimatePromptTokens = __E.estimatePromptTokens ?? ((body) => 0);
export const estimateTokens = __E.estimateTokens ?? ((text) => Math.max(1, Math.floor(String(text ?? '').length / 4)));
export const factorFor = __E.factorFor ?? (() => 1);
export const familyOf = __E.familyOf ?? (() => 'default');
export const observePrompt = __E.observePrompt ?? ((model) => ({ family: 'default', factor: 1, ratio: 0, learned: false }));
export const resetCalibration = __E.resetCalibration ?? (() => {});
