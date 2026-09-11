// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("potatoMechanics") ?? {};

export const POTATO_MECHANICS_MARKER = __E.POTATO_MECHANICS_MARKER ?? "";
export const POTATO_MECHANICS_PROMPT = __E.POTATO_MECHANICS_PROMPT ?? "";
export const hasPotatoMechanics = __E.hasPotatoMechanics ?? (() => false);
export const injectPotatoMechanics = __E.injectPotatoMechanics ?? (() => {});
