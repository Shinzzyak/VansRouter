// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "promptGateMemory";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const PROMPT_GATE_MAX_AGE_MS = (loadEngine(__M) ?? {})["PROMPT_GATE_MAX_AGE_MS"] ?? (6 * 60 * 60 * 1000);
export const _resetPromptGate = __g("_resetPromptGate", (() => {}));
export const classifyPromptShapeRejection = __g("classifyPromptShapeRejection", (() => ({ rejected: false, reason: null })));
export const isPromptGated = __g("isPromptGated", (() => false));
export const promptGateSnapshot = __g("promptGateSnapshot", (() => []));
export const recordPromptShapeRejection = __g("recordPromptShapeRejection", (() => {}));
