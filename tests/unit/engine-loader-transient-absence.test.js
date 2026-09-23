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
const BUNDLE = engineBundlePath();
const HIDDEN = `${BUNDLE}.test-hidden`;

const hasBundle = isEngineLoaded();

afterEach(() => {
  // Never leave the bundle hidden, whatever a test did.
  if (existsSync(HIDDEN) && !existsSync(BUNDLE)) renameSync(HIDDEN, BUNDLE);
});

describe.skipIf(!hasBundle)("loader cache: hit forever, miss re-checked", () => {
  it("a transient absence self-heals on the very next call", async () => {
    renameSync(BUNDLE, HIDDEN);
    // Fresh specifier = fresh module instance, so this test owns its cache state
    // and cannot be poisoned by the other suites in the same worker.
    const loader = await import(`open-sse/rtk/engineLoader.js?transient=1`);
    expect(existsSync(BUNDLE)).toBe(false);
    expect(loader.isEngineLoaded(), "absent at import time").toBe(false);

    renameSync(HIDDEN, BUNDLE);
    expect(existsSync(BUNDLE), "bundle restored").toBe(true);

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
    renameSync(BUNDLE, HIDDEN);
    expect(loader.isEngineLoaded(), "hit survives the file disappearing").toBe(true);
    expect(loader.engineBundlePath()).toBe(first);
  }, 15000);
});
