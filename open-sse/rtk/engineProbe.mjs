#!/usr/bin/env node
// Deploy gate probe: prove the private engine bundle is reachable from where
// the standalone server actually runs.
//
// This file deliberately lives INSIDE open-sse/rtk/ rather than scripts/:
// open-sse is copied into the standalone artifact on every build, scripts/ is
// not reliable there. Run it from the deployed standalone directory:
//
//   cd <repo>/.next/standalone && node open-sse/rtk/engineProbe.mjs
//
// Exit 0 + "LOADED:<path>"  -> engine resolved, the product is live
// Exit 1 + "ABSENT"         -> degraded plain-proxy mode, do NOT call this a
//                              successful deploy
//
// Why a probe instead of checking for the file: the file existing and the
// loader FINDING it are different facts. The loader anchors on the live cwd
// and on the shim's own location, both of which differ between a developer
// shell and the standalone server. Only the probe tests the real thing.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const candidates = [
  resolve(HERE, "engineLoader.js"),                        // same dir
  resolve(process.cwd(), "open-sse/rtk/engineLoader.js"),  // standalone cwd
  resolve(process.cwd(), "node_modules/open-sse/rtk/engineLoader.js"),
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
