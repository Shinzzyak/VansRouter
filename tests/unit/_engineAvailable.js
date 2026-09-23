// Shared probe: is the private engine bundle available in this environment?
//
// The engine (godmode framing, bypass engine, compaction reassert, potato
// mechanics, instruction plan, response integrity) is NOT in the repository —
// it ships as data/engine/engine.cjs, gitignored and outside the deploy
// tarball. Tests that assert real engine BEHAVIOR can only run where that
// bundle exists (a developer machine / the VPS), never on a CI runner.
//
// Use it as:  describe.skipIf(!engineAvailable())("real engine behavior", ...)
//
// Tests that assert the DEGRADED path must not use this — they are the ones
// that matter on CI, and they are the Zero Break Guarantee.

// ASK THE LOADER (2026-09-23). This used to list the two DEV paths —
// `<cwd>/data/engine/engine.cjs` and `<repo>/data/engine/engine.cjs` — and miss
// the one the loader actually resolves first,
// `.next/standalone/data/engine/engine.cjs`. On any checkout that has been
// deployed the dev copy does not exist (the deploy script deletes it on purpose,
// "stale hand-placed bundle") while the standalone copy does, so this probe said
// false and ELEVEN suites silently skipped their engine-behavior assertions:
// measured 6 skipped in engine-fail-open alone, and the full-suite skip count
// read 82 instead of the real coverage. Calling the loader makes this file and
// the runtime agree by construction — it is the same function the request path
// uses.
import { isEngineLoaded } from "open-sse/rtk/engineLoader.js";

export function engineAvailable() {
  // isEngineLoaded() already honours VR_ENGINE_DISABLE, and it caches a HIT, so
  // this stays a cheap call inside a describe().
  return isEngineLoaded();
}
