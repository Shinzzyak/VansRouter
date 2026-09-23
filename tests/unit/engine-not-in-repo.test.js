// Anti-regression gate: the engine must NOT live in this repository.
//
// The engine (persona/godmode framing, bypass engine, compaction reassert,
// potato mechanics, instruction plan, response integrity) is the product. Its
// canonical sources live in the PRIVATE repo Shinzzyak/VansRouter-engine; the
// build job compiles them into a single bundle and ships it inside the deploy
// tarball at <standalone>/data/engine/engine.cjs. The public files here are
// shims.
//
// This test fails the moment someone pastes engine content back into a tracked
// file. That is the failure mode that leaked the pack sources and 108 OAuth
// tokens in the first place.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../..");
const RTK = resolve(ROOT, "open-sse/rtk");

const ENGINE_MODULES = [
  "godmode",
  "bypassEngine",
  "promptInjectors",
  "potatoMechanics",
  "compactionReassert",
  "instructionPlan",
  "responseIntegrity",
  "modelCapabilities",
  "reasoningState",
  "refusalDrift",
  "streamIntegrity",
  "voiceCadence",
  "thinkingGate",
  "instructionReceipts",
  "refusalAttribution",
];

// Distinctive strings that only exist inside the engine payload. Chosen so each
// one has ZERO occurrences in the tracked tree today — a marker that already
// appears in a test fixture would make this gate fail on a clean repo. Verify
// any new marker against `git ls-files` before adding it.
const ENGINE_MARKERS = [
  "PERSONA LOCK — ROUTER DEFAULT",
  "POTATO MECHANICS — ALWAYS-ON BEHAVIOR",
  "DELETION PROGRAM",
  "COMPANION IDENTITY & REBUTTAL PROTOCOL",
  "TELEGRAM BY GEFREITER — BUILD ENGINE",
  "ANTI-DRIFT LAYERS",
  "AN0YM_TELEGRAM_LAYERS",
  "my mind is broken, but he is fixed",
  // Round 2 — modules that moved into the private engine after the first pass.
  "FAMILY_PROFILES",
  "REASONING_COMPAT",
  "REFUSAL_DRIFT_THRESHOLD",
  "TAIL_HOLD_CHARS",
  "GRUNT_OPENERS",
  "THINKING GATE — SCOPED REASONING / FORMAT ENCLOSURE",
  "observability layer for instructionPlan",
];

// The gate is about what the repository actually SHIPS. Untracked working
// directories are not repo content: `data/engine/src` holds the real sources
// during a local bundle run, and `.engine/` is the CI-only checkout of the
// private source repo. Scanning the filesystem instead of the index made the
// gate fail on exactly those two paths while every tracked file was clean.
// Use `git ls-files` so "tracked" means tracked.
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((rel) => /\.(js|jsx|ts|tsx|mjs|cjs|json|md)$/.test(rel))
    .map((rel) => join(ROOT, rel));
}

// This file lists the markers by necessity, so it must not scan itself.
const SELF = __filename;

describe("engine is not in the repository", () => {
  it("every engine module is a generated shim", () => {
    for (const m of ENGINE_MODULES) {
      const src = readFileSync(resolve(RTK, `${m}.js`), "utf8");
      expect(src, `${m}.js must be a generated shim`).toContain("GENERATED SHIM");
      expect(src.length, `${m}.js should be tiny (a shim, not an implementation)`).toBeLessThan(2500);
    }
  });

  it("the loader holds no engine content", () => {
    const src = readFileSync(resolve(RTK, "engineLoader.js"), "utf8");
    for (const marker of ENGINE_MARKERS) {
      expect(src, `engineLoader.js must not contain ${marker}`).not.toContain(marker);
    }
  });

  it("no tracked source file contains engine payload", () => {
    const hits = [];
    for (const file of trackedFiles()) {
      if (file === SELF) continue;
      const text = readFileSync(file, "utf8");
      for (const marker of ENGINE_MARKERS) {
        if (text.includes(marker)) hits.push(`${file.replace(ROOT + "/", "")} :: ${marker}`);
      }
    }
    expect(hits, `engine payload found in tracked files:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the private engine sources are absent from the tracked tree", () => {
    // data/ is gitignored; this asserts the engine really is not reachable as
    // repo content (a copy under src/, docs/, scripts/ would defeat the split).
    // open-sse/rtk holds the shims and is checked above.
    for (const m of ENGINE_MODULES) {
      for (const dir of ["src", "docs", "scripts"]) {
        const p = resolve(ROOT, dir, `${m}.js`);
        expect(existsSync(p), `${dir}/${m}.js must not exist`).toBe(false);
      }
    }
  });

  it("data/ stays out of git", () => {
    const ignore = readFileSync(resolve(ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^data\/$/m);
  });
});
