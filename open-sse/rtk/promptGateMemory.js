// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("promptGateMemory") ?? {};

export const _resetPromptGate = __E._resetPromptGate ?? (() => {});
export const classifyPromptShapeRejection = __E.classifyPromptShapeRejection ?? (() => ({ rejected: false, reason: null }));
export const isPromptGated = __E.isPromptGated ?? (() => false);
export const isRouterScaffoldingPrompt = __E.isRouterScaffoldingPrompt ?? (() => false);
export const promptGateSnapshot = __E.promptGateSnapshot ?? (() => []);
export const recordPromptShapeRejection = __E.recordPromptShapeRejection ?? (() => {});
