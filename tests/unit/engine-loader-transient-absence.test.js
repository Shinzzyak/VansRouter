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

afterEach(() => {
  // Never leave any copy hidden, whatever a test did.
  for (const { path, hidden } of LAYOUTS) {
    if (existsSync(hidden)) renameSync(hidden, path);
  }
});

describe.skipIf(!hasBundle)("loader cache: hit forever, miss re-checked", () => {
  it("a transient absence self-heals on the very next call", async () => {
    for (const { path, hidden } of LAYOUTS) renameSync(path, hidden);
    // Fresh specifier = fresh module instance, so this test owns its cache state
    // and cannot be poisoned by the other suites in the same worker.
    const loader = await import(`open-sse/rtk/engineLoader.js?transient=1`);
    for (const { path } of LAYOUTS) expect(existsSync(path), `${path} hidden`).toBe(false);
    expect(loader.isEngineLoaded(), "absent at import time").toBe(false);

    for (const { path, hidden } of LAYOUTS) renameSync(hidden, path);
    for (const { path } of LAYOUTS) expect(existsSync(path), "bundle restored").toBe(true);

    // The whole point: no restart, no timer, no retry window — the next call sees
    // it. This is the assertion that fails against the old unconditional cache.
    expect(loader.isEngineLoaded(), "self-healed on the next call").toBe(true);
    expect(loader.engineBundlePath()).toBe(BUNDLE);
  }, 15000);

  it("a hit is cached, so the request path pays no repeated disk read", async () => {
    const loader = await import(`open-sse/rtk/engineLoader.js?hit=1`);
    expect(loader.isEngineLoaded()).toBe(true);
    const first = loader.engineBundlePath();
    // Hide the file: a cached HIT must keep answering from memory and must not
    // re-read the disk. If the hit were re-resolved this would go false.
    for (const { path, hidden } of LAYOUTS) renameSync(path, hidden);
    expect(loader.isEngineLoaded(), "hit survives the file disappearing").toBe(true);
    expect(loader.engineBundlePath()).toBe(first);
  }, 15000);
});
