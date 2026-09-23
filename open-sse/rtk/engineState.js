// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("engineState") ?? {};

export const _resetStatePath = __E._resetStatePath ?? (() => {});
export const hydrate = __E.hydrate ?? (() => false);
export const installFlushHooks = __E.installFlushHooks ?? (() => {});
export const markDirty = __E.markDirty ?? (() => {});
export const persist = __E.persist ?? (() => false);
export const registerState = __E.registerState ?? (() => {});
export const stateFilePath = __E.stateFilePath ?? (() => null);
export const stateStatus = __E.stateStatus ?? (() => ({ file: null, slots: [], enabled: false, dirty: false, debounceMs: 0 }));
