// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("godmode") ?? {};

export const GODMODE_ENABLED = __E.GODMODE_ENABLED ?? true;
export const GODMODE_LEVELS = __E.GODMODE_LEVELS ?? Object.freeze([]);
export const GODMODE_ON_PROMPT_EXPORT = __E.GODMODE_ON_PROMPT_EXPORT ?? "";
export const PERSONA_LOCK_PROMPT = __E.PERSONA_LOCK_PROMPT ?? "";
export const injectGodmode = __E.injectGodmode ?? (() => {});
export const injectPersonaLock = __E.injectPersonaLock ?? (() => {});
export const normalizeGodmodeLevel = __E.normalizeGodmodeLevel ?? (() => null);
