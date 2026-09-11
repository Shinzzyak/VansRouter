// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("thinkingGate") ?? {};

export const GO_TOKEN = __E.GO_TOKEN ?? 'GO.';
export const THINKING_GATE_MARKER = __E.THINKING_GATE_MARKER ?? '';
export const THINKING_GATE_PROMPT = __E.THINKING_GATE_PROMPT ?? '';
export const hasThinkingGate = __E.hasThinkingGate ?? (() => false);
export const injectThinkingGate = __E.injectThinkingGate ?? ((body) => body);
export const isThinkingModel = __E.isThinkingModel ?? (() => false);
export const matchesFormatEnclosure = __E.matchesFormatEnclosure ?? (() => false);
