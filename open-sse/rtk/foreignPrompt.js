// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("foreignPrompt") ?? {};

export const FOREIGN_PROMPT_MAX_STRIP_CHARS = __E.FOREIGN_PROMPT_MAX_STRIP_CHARS ?? 600;
export const FOREIGN_PROMPT_SEP = __E.FOREIGN_PROMPT_SEP ?? "\n\n";
export const classifyForeignSegment = __E.classifyForeignSegment ?? (() => null);
export const detectForeignPrompts = __E.detectForeignPrompts ?? (() => ({ stripped: 0, hits: [] }));
export const isOwnSegment = __E.isOwnSegment ?? (() => false);
export const stripForeignPrompts = __E.stripForeignPrompts ?? (() => ({ stripped: 0, hits: [] }));
