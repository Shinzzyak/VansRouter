// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "thinkingGate";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const GO_TOKEN = (loadEngine(__M) ?? {})["GO_TOKEN"] ?? 'GO.';
export const THINKING_GATE_MARKER = (loadEngine(__M) ?? {})["THINKING_GATE_MARKER"] ?? '';
export const THINKING_GATE_PROMPT = (loadEngine(__M) ?? {})["THINKING_GATE_PROMPT"] ?? '';
export const hasThinkingGate = __g("hasThinkingGate", (() => false));
export const injectThinkingGate = __g("injectThinkingGate", ((body) => body));
export const isThinkingModel = __g("isThinkingModel", (() => false));
export const matchesFormatEnclosure = __g("matchesFormatEnclosure", (() => false));
