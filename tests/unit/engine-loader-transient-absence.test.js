// Guards for the loader's cache: a HIT is forever, a MISS is re-checked.
//
// FINDING (2026-09-23). `resolveBundle()` cached its verdict for the life of the
// process:
//
//   if (_bundle !== undefined) return _bundle;   // both a hit AND a miss
//
// That is right for a hit and wrong for a miss, because the bundle legitimately
// disappears for a few seconds during a deploy. The deploy script does
// `mv standalone standalone_old` and only THEN untars the new build, so a
// process whose first request lands in that window cached "ABSENT" and stayed a
// plain proxy for its entire life — router up, deploy gate green (it greps a
// fresh probe, not this process), and the product silently not there.
//
// Reproduced by hiding the bundle, importing the loader, then restoring it:
// `isEngineLoaded()` returned false both before AND after the file was back.
//
// These tests pin BOTH halves of the contract, because either one alone is a bug:
// the miss must self-heal, and the hit must stay cached (that cache is what keeps
// the request path free of disk I/O).
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { isEngineLoaded, engineBundlePath } from "open-sse/rtk/engineLoader.js";

// USE THE LOADER'S OWN PATH, never a hardcoded one.
//
// The first version of this file hardcoded `.next/standalone/data/engine/engine.cjs`
// because that is what the DEV machine and the deployed VPS resolve. CI is the
// other layout: the engine gates run BEFORE the bundle is copied into the
// standalone artifact, so at that moment the bundle is at
// `<repo>/data/engine/engine.cjs` and the standalone path does not exist yet —
// rename() threw ENOENT and failed the build. Asking the loader gives the path
// the runtime actually uses, in every layout. (Same lesson as
// _engineAvailable.js, one file over: do not infer runtime state from a path.)
const ROOT = resolve(__dirname, "../..");
const BUNDLE = engineBundlePath();

// Hide EVERY layout the loader knows about, not just the one it happened to
// resolve. The loader walks a candidate list and takes the first hit, so on a
// checkout that carries more than one copy — a dev machine that has also been
// deployed has both `.next/standalone/data/engine/engine.cjs` and
// `data/engine/engine.cjs` — renaming only the resolved path leaves the engine
// reachable at the next candidate and the test reads `true` where it asserted
// `false`. Measured 2026-09-23: green with one layout on disk, red with two, and
// the code under test was correct in both cases. The test was over-specified.
//
// Every path is restored in afterEach, and restoration is asserted: a test that
// leaves a bundle hidden breaks every suite that runs after it in the same
// worker, which is a far worse failure than the one being tested.
const LAYOUTS = [
  BUNDLE,
  resolve(ROOT, "data/engine/engine.cjs"),
  resolve(ROOT, ".next/standalone/data/engine/engine.cjs"),
  process.env.VR_ENGINE_BUNDLE,
]
  .filter(Boolean)
  .filter((p, i, a) => a.indexOf(p) === i)
  .filter((p) => existsSync(p))
  .map((p) => ({ path: p, hidden: `${p}.test-hidden` }));

const hasBundle = isEngineLoaded();

/** Hide every layout the loader knows about. */
function hideAll() {
  for (const { path, hidden } of LAYOUTS) renameSync(path, hidden);
}

/**
 * Put every hidden copy back. Idempotent — safe to call when nothing is hidden.
 *
 * This is called from THREE places on purpose: the test's own `finally`, and
 * `afterEach` as a last-resort backstop. The `finally` is what matters — see the
 * note on test 2 below.
 */
function restoreAll() {
  for (const { path, hidden } of LAYOUTS) {
    if (existsSync(hidden)) renameSync(hidden, path);
  }
}

afterEach(() => {
  // Never leave any copy hidden, whatever a test did.
  restoreAll();
});

describe.skipIf(!hasBundle)("loader cache: hit forever, miss re-checked", () => {
  it("a transient absence self-heals on the very next call", async () => {
    hideAll();
    // The window below is the ONE yield in this file: `await import()` resolves
    // while the bundle is still hidden, so any other file scheduled on a
    // concurrent worker can import a shim and snapshot `{}`. That is inherent to
    // what this test proves (a MISS must be re-checked, so the bundle has to be
    // absent at import time) and cannot be removed here — only guaranteed to end.
    //
    // Hence try/finally: if either assertion between hide and restore throws,
    // `afterEach` alone would leave the bundle hidden for the rest of the
    // worker's life and break every suite scheduled after it. Restoring in the
    // same tick as the assertion closes that, and is the same discipline the
    // next test uses.
    //
    // The loader instance is deliberately captured OUTSIDE the try so the
    // assertion after the restore runs against the SAME instance that cached the
    // miss. A fresh import would see the file trivially and prove nothing.
    let loader;
    try {
      // Fresh specifier = fresh module instance, so this test owns its cache state
      // and cannot be poisoned by the other suites in the same worker.
      loader = await import(`open-sse/rtk/engineLoader.js?transient=1`);
      for (const { path } of LAYOUTS) expect(existsSync(path), `${path} hidden`).toBe(false);
      expect(loader.isEngineLoaded(), "absent at import time").toBe(false);
    } finally {
      restoreAll();
    }

    for (const { path } of LAYOUTS) expect(existsSync(path), "bundle restored").toBe(true);

    // The whole point: no restart, no timer, no retry window — the next call on
    // the SAME instance sees it. This is the assertion that fails against the old
    // unconditional cache.
    expect(loader.isEngineLoaded(), "self-healed on the next call").toBe(true);
    expect(loader.engineBundlePath()).toBe(BUNDLE);
  }, 15000);

  it("a hit is cached, so the request path pays no repeated disk read", async () => {
    const loader = await import(`open-sse/rtk/engineLoader.js?hit=1`);
    expect(loader.isEngineLoaded()).toBe(true);
    const first = loader.engineBundlePath();
    // Hide the file: a cached HIT must keep answering from memory and must not
    // re-read the disk. If the hit were re-resolved this would go false.
    try {
      hideAll();
      expect(loader.isEngineLoaded(), "hit survives the file disappearing").toBe(true);
      expect(loader.engineBundlePath()).toBe(first);
    } finally {
      // Restore HERE, not only in afterEach. The suite hides the bundle for the
      // whole worker process; a restore that waits for afterEach leaves the file
      // hidden while the next file in the same worker is still importing its
      // shims. Measured 2026-09-23: thinking-gate.test.js read `[ENGINE] ABSENT`
      // at import and failed 9/16 tests against a correct engine. Restoring in
      // the same tick as the assertion closes that window.
      restoreAll();
    }
  }, 15000);
});
