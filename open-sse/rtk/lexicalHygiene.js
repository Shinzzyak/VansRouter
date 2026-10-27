// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "lexicalHygiene";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const INSTRUCTION_LEAK_INTERNAL_MIN = (loadEngine(__M) ?? {})["INSTRUCTION_LEAK_INTERNAL_MIN"] ?? 3;
export const INSTRUCTION_LEAK_RATIO = (loadEngine(__M) ?? {})["INSTRUCTION_LEAK_RATIO"] ?? 0.5;
export const INSTRUCTION_LEAK_RUN_MIN = (loadEngine(__M) ?? {})["INSTRUCTION_LEAK_RUN_MIN"] ?? 60;
export const LEXICAL_SIGNATURES = (loadEngine(__M) ?? {})["LEXICAL_SIGNATURES"] ?? Object.freeze([]);
export const findHardLeaks = __g("findHardLeaks", (() => []));
export const findInstructionLeak = __g("findInstructionLeak", (() => ({ leaked: false, id: null, hits: 0, total: 0, ratio: 0, quote: '', reason: null })));
export const findLexicalSignatures = __g("findLexicalSignatures", (() => []));
export const findParaphraseLeak = __g("findParaphraseLeak", (() => ({ leaked: false, id: null, hits: 0, total: 0, ratio: 0, quote: '', reason: 'paraphrase' })));
export const instructionLeakAxes = __g("instructionLeakAxes", (() => ({ run: 0, markers: 0, owner: null })));
export const instructionLeakBlocks = __g("instructionLeakBlocks", (() => []));
export const stripInvisibleCarriers = __g("stripInvisibleCarriers", ((t) => ({ text: t ?? '', removed: 0 })));
