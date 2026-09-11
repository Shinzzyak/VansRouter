// Runtime loader for the private engine bundle.
//
// The engine (godmode framing, bypass engine, compaction reassert, potato
// mechanics, instruction plan, response integrity) is NOT in this repository.
// It ships as a single CJS bundle that lives outside the deploy tarball:
//
//   data/engine/engine.cjs          <- gitignored, survives every deploy
//
// This module is public and contains no engine content. When the bundle is
// absent every shim degrades to a safe no-op and the router keeps working as a
// plain [OI]-compatible proxy — that is the Zero Break Guarantee, and it is
// exercised by tests/unit/engine-fail-open.test.js.
//
// Resolution order (first hit wins):
//   1. $VR_ENGINE_BUNDLE                     explicit override
//   2. walk up from <cwd>/data/engine/engine.cjs     production (PM2 cwd = repo root)
//   3. walk up from <this file>/../../../data/engine/engine.cjs
//   4. walk up from <this file>/../../../../data/engine/engine.cjs   (standalone nesting)
//
// The walk-up matters: Next.js bundles this module into .next/server, so
// `import.meta.url` is FROZEN AT BUILD TIME (it points at the CI runner's
// checkout) and the standalone server chdirs into .next/standalone. Anchoring
// only on those two paths silently misses the bundle on a real deploy — the
// router then degrades with no visible error. Walking up from the live cwd
// finds <repo>/data/engine/engine.cjs from either location.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve, parse } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/** Collect `<dir>/data/engine/engine.cjs` for dir and every ancestor. */
function walkUp(startDir, maxLevels = 6) {
  const out = [];
  let dir = resolve(startDir);
  for (let i = 0; i < maxLevels; i++) {
    out.push(resolve(dir, "data/engine/engine.cjs"));
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) break;
    dir = parent;
  }
  return out;
}

const CANDIDATES = [
  process.env.VR_ENGINE_BUNDLE || null,
  // Live cwd first — this is the one that works in production.
  ...walkUp(process.cwd()),
  ...walkUp(resolve(HERE, "../../..")),
  ...walkUp(resolve(HERE, "../../../..")),
].filter((p, i, a) => p && a.indexOf(p) === i);

let _bundle;      // undefined = not resolved yet, null = absent
let _loadedPath = null;

function resolveBundle() {
  if (_bundle !== undefined) return _bundle;
  // Escape hatch: force the degraded path. Used by the fail-open test suite and
  // available as a "safe mode" switch on the VPS.
  if (process.env.VR_ENGINE_DISABLE) {
    console.log("[ENGINE] disabled via VR_ENGINE_DISABLE — degraded to plain proxy mode");
    _bundle = null;
    return _bundle;
  }
  for (const p of CANDIDATES) {
    try {
      if (existsSync(p)) {
        _bundle = require_(p);
        _loadedPath = p;
        // One boot line. The deploy pipeline greps for it to prove the engine
        // actually came up, instead of trusting that the file is on disk.
        console.log(`[ENGINE] loaded | ${p} | ${Object.keys(_bundle).length} modules`);
        return _bundle;
      }
    } catch (e) {
      // A corrupt bundle must not take the router down — treat as absent.
      console.error(`[ENGINE] failed to load ${p}: ${e.message}`);
    }
  }
  console.warn(
    `[ENGINE] ABSENT — degraded to plain proxy mode (searched: ${CANDIDATES.join(", ")})`
  );
  _bundle = null;
  return _bundle;
}

/**
 * Return the engine namespace for a module, or null when the bundle is absent.
 * Never throws.
 * @param {string} name
 * @returns {object|null}
 */
export function loadEngine(name) {
  try {
    const b = resolveBundle();
    if (!b) return null;
    return b[name] || null;
  } catch (e) {
    console.error(`[ENGINE] loadEngine(${name}) failed: ${e.message}`);
    return null;
  }
}

/** True when the private engine bundle was found and loaded. */
export function isEngineLoaded() {
  return resolveBundle() !== null;
}

/** Absolute path of the loaded bundle, or null. For logging/diagnostics only. */
export function engineBundlePath() {
  resolveBundle();
  return _loadedPath;
}
