// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "heartbeat";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const HEARTBEAT = (loadEngine(__M) ?? {})["HEARTBEAT"] ?? Object.freeze({ DEFAULT_INTERVAL_MS: 0, DEFAULT_TIMEOUT_MS: 0 });
export const heartbeatPayload = __g("heartbeatPayload", (() => null));
export const sendHeartbeat = __g("sendHeartbeat", async () => ({ ok: false, skipped: 'engine absent' }));
export const startHeartbeat = __g("startHeartbeat", (() => ({ beatOnce: async () => ({ ok: false, skipped: 'engine absent' }), stop() {}, running: false })));
