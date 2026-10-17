// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("selfDescriptionScrub") ?? {};

export const SELF_DESCRIPTION_SCRUB_HEAD_CHARS = __E.SELF_DESCRIPTION_SCRUB_HEAD_CHARS ?? 600;
export const scrubSelfDescriptionLab = __E.scrubSelfDescriptionLab ?? ((text) => ({ text: String(text ?? ''), changed: false, hits: [] }));
export const stripPromptDump = __E.stripPromptDump ?? ((text) => ({ text: String(text ?? ''), changed: false, hits: [] }));
