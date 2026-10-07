// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("lexicalHygiene") ?? {};

export const INSTRUCTION_LEAK_INTERNAL_MIN = __E.INSTRUCTION_LEAK_INTERNAL_MIN ?? 3;
export const INSTRUCTION_LEAK_RATIO = __E.INSTRUCTION_LEAK_RATIO ?? 0.5;
export const INSTRUCTION_LEAK_RUN_MIN = __E.INSTRUCTION_LEAK_RUN_MIN ?? 60;
export const LEXICAL_SIGNATURES = __E.LEXICAL_SIGNATURES ?? Object.freeze([]);
export const findHardLeaks = __E.findHardLeaks ?? (() => []);
export const findInstructionLeak = __E.findInstructionLeak ?? (() => ({ leaked: false, id: null, hits: 0, total: 0, ratio: 0, quote: '', reason: null }));
export const findLexicalSignatures = __E.findLexicalSignatures ?? (() => []);
export const findParaphraseLeak = __E.findParaphraseLeak ?? (() => ({ leaked: false, id: null, hits: 0, total: 0, ratio: 0, quote: '', reason: 'paraphrase' }));
export const instructionLeakBlocks = __E.instructionLeakBlocks ?? (() => []);
