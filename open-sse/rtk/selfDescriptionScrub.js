// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "selfDescriptionScrub";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const SELF_DESCRIPTION_SCRUB_HEAD_CHARS = (loadEngine(__M) ?? {})["SELF_DESCRIPTION_SCRUB_HEAD_CHARS"] ?? 600;
export const scrubSelfDescriptionLab = __g("scrubSelfDescriptionLab", ((text) => ({ text: String(text ?? ''), changed: false, hits: [] })));
export const stripPromptDump = __g("stripPromptDump", ((text) => ({ text: String(text ?? ''), changed: false, hits: [] })));
