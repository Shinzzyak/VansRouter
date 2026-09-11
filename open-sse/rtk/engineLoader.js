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
//   1. $VR_ENGINE_BUNDLE
//   2. walk up from <cwd>/.next/standalone/data/engine/engine.cjs   <- production
//   3. walk up from <cwd>/data/engine/engine.cjs                    <- dev machine
//   4. walk up from <this file>/../../../data/engine/engine.cjs
//   5. walk up from <this file>/../../../../data/engine/engine.cjs
//
// Candidate 2 is the one production uses. The deploy tarball carries the bundle
// at <standalone>/data/engine/engine.cjs, compiled in CI and never built on the
// host. It deliberately outranks candidate 3: a stale hand-placed copy at the
// deploy root must never win over the artifact that actually shipped.
//
// Two traps this file exists to survive:
//
//   (a) Next.js bundles this module into .next/server/chunks/*, so
//       `import.meta.url` is FROZEN AT BUILD TIME — it points at the CI
//       runner's checkout (/home/runner/work/...), not the VPS. And the
//       standalone server runs from .next/standalone, not the repo root.
//       Anchoring only on those two paths silently misses the bundle on
//       every real deploy. Hence the walk-up from the live cwd.
//
//   (b) webpack rewrites `createRequire(import.meta.url)` into its own
//       require factory, which throws `Cannot find module` for an absolute
//       path that plainly exists on disk. So the bundle is NOT loaded with
//       require/createRequire at all — it is read and compiled directly,
//       with `process.getBuiltinModule` serving any `node:*` import.
//       scripts/engine-bundle.mjs enforces that the bundle requires nothing
//       but node builtins.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, parse } from "node:path";
import { fileURLToPath } from "node:url";

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
  // The shipped artifact first: <cwd>/.next/standalone/data/engine/engine.cjs.
  // This is what the CI-built tarball carries, and it must win over any stale
  // copy left at the deploy root — otherwise a hand-placed file from an old
  // manual build silently overrides every deploy.
  ...walkUp(resolve(process.cwd(), ".next/standalone")),
  // Then the live cwd itself. This is what makes the dev-machine and
  // probe-from-standalone cases work.
  ...walkUp(process.cwd()),
  ...walkUp(resolve(HERE, "../../..")),
  ...walkUp(resolve(HERE, "../../../..")),
].filter((p, i, a) => p && a.indexOf(p) === i);

/**
 * Minimal require for the bundle: node builtins only.
 * Deliberately does NOT go through require/createRequire — webpack rewrites
 * those in a Next.js server bundle and they throw for absolute paths.
 */
function builtinRequire(id) {
  const g = process.getBuiltinModule;
  if (typeof g === "function") {
    const mod = g(id);
    if (mod) return mod;
  }
  if (id.startsWith("node:")) {
    const mod = g ? g(id.slice(5)) : null;
    if (mod) return mod;
  }
  throw new Error(
    `engine bundle requested "${id}" — only node builtins are available to it`
  );
}

/**
 * Compile a CJS bundle from disk without touching require machinery.
 * @param {string} path
 */
function compileBundle(path) {
  const src = readFileSync(path, "utf8");
  const module_ = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "module",
    "exports",
    "require",
    "__filename",
    "__dirname",
    src
  );
  factory(module_, module_.exports, builtinRequire, path, dirname(path));
  const out = module_.exports;
  if (!out || typeof out !== "object" || Object.keys(out).length === 0) {
    throw new Error("bundle compiled but exported nothing");
  }
  return out;
}

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
        _bundle = compileBundle(p);
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
