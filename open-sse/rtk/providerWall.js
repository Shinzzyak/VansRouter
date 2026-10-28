// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "providerWall";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const WALL_EVIDENCE = (loadEngine(__M) ?? {})["WALL_EVIDENCE"] ?? 2;
export const explainWall = __g("explainWall", ((m) => `wall: no bundle (${m == null ? '?' : String(m)})`));
export const nodesForModel = __g("nodesForModel", (() => []));
export const noteNodeVerdict = __g("noteNodeVerdict", (() => null));
export const providerWallId = __g("providerWallId", ((p, m) => `${p == null ? '' : String(p)}|${m == null ? '' : String(m)}`));
export const rankNodesForModel = __g("rankNodesForModel", ((_m, providers) => (Array.isArray(providers) ? providers : [])));
export const resetProviderWall = __g("resetProviderWall", (() => {}));
export const wallSnapshot = __g("wallSnapshot", (() => ({})));
export const wallVerdict = __g("wallVerdict", (() => 'unknown'));
