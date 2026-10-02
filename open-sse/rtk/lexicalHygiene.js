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

export const LEXICAL_SIGNATURES = __E.LEXICAL_SIGNATURES ?? Object.freeze([]);
export const findHardLeaks = __E.findHardLeaks ?? (() => []);
export const findLexicalSignatures = __E.findLexicalSignatures ?? (() => []);
