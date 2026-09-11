#!/usr/bin/env node
// Deploy gate: prove the private engine bundle is reachable from where the
// standalone server actually runs.
//
// Run this from the deployed standalone directory (what Next.js chdirs into):
//
//   cd <repo>/.next/standalone && node scripts/engine-probe.mjs
//
// Exit 0 + "LOADED:<path>"  -> engine resolved, the product is live
// Exit 1 + "ABSENT"         -> degraded plain-proxy mode, do NOT call this a
//                              successful deploy
//
// Why a probe instead of checking for the file: the file existing and the
// loader FINDING it are different facts. The loader anchors on the live cwd
// and on this script's own location, both of which differ between a developer
// shell and the standalone server. Only the probe tests the real thing.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const candidates = [
  resolve(HERE, "../open-sse/rtk/engineLoader.js"),
  resolve(HERE, "../node_modules/open-sse/rtk/engineLoader.js"),
  resolve(process.cwd(), "open-sse/rtk/engineLoader.js"),
];

const loaderPath = candidates.find((p) => existsSync(p));

if (!loaderPath) {
  console.log(`ABSENT: loader module not found (tried ${candidates.join(", ")})`);
  process.exit(1);
}

try {
  const mod = await import(loaderPath);
  if (mod.isEngineLoaded()) {
    console.log(`LOADED:${mod.engineBundlePath()}`);
    process.exit(0);
  }
  console.log("ABSENT: bundle not found by the loader");
  process.exit(1);
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  process.exit(1);
}
