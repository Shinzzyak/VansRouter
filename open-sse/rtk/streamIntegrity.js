// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("streamIntegrity") ?? {};

export const classifyStreamContent = __E.classifyStreamContent ?? (() => ({ status: 'ok', chars: 0, brandOk: null, refusal: false, engineMissing: true }));
export const createStreamIntegrityObserver = __E.createStreamIntegrityObserver ?? (() => ({ push: () => {}, finish: () => ({ status: 'ok', chars: 0, brandOk: null, refusal: false, engineMissing: true }) }));
