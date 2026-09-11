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

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function engineAvailable() {
  if (process.env.VR_ENGINE_DISABLE) return false;
  const candidates = [
    process.env.VR_ENGINE_BUNDLE,
    resolve(process.cwd(), "data/engine/engine.cjs"),
    resolve(__dirname, "../../data/engine/engine.cjs"),
  ].filter(Boolean);
  return candidates.some((p) => existsSync(p));
}
