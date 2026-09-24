// Guards for the update banner (2026-09-25).
//
// THE DEFECT. `/api/version` compares the running version against the npm
// `latest` of the package named `vansrouter` — and that package is UPSTREAM's
// (maintainer `blugaaaaaaaa`, repository Vanszs/VansRouter), not this fork's.
// Every time upstream publishes above the local version the dashboard shows
// "New version available" together with `npm i -g vansrouter@latest
// --prefer-online`: an install command that REPLACES this build with upstream and
// drops the capability layer with it.
//
// The earlier fix bumped the local version to 0.91.31 and the banner went quiet —
// until upstream published 0.91.31 and then 0.91.32 inside the same day and it
// came back. The version number was never the control; the CHANNEL is. This build
// ships as a licence-gated pack and has no npm artifact, so the check can only
// ever emit a wrong instruction.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

describe("update channel is the control, not the version number", () => {
  it("UPDATER_CONFIG declares a pack channel by default", () => {
    const src = read("src/shared/constants/config.js");
    expect(src).toMatch(/updateChannel:\s*"pack"/);
  });

  it("/api/version skips the npm lookup unless the channel is npm", () => {
    const src = read("src/app/api/version/route.js");
    // The gate must exist and must be the thing that decides.
    expect(src).toMatch(/UPDATE_CHECK_ENABLED\s*=\s*UPDATER_CONFIG\.updateChannel\s*===\s*"npm"/);
    expect(src).toMatch(/UPDATE_CHECK_ENABLED\s*\?\s*await\s+getLatestVersionCached\(\)\s*:\s*null/);
  });

  it("reports the channel so callers can tell 'not checked' from 'up to date'", () => {
    const src = read("src/app/api/version/route.js");
    expect(src).toMatch(/updateChannel:\s*UPDATER_CONFIG\.updateChannel/);
  });

  it("keeps the npm lookup itself intact for a build that owns the package", () => {
    // Flipping updateChannel to "npm" must restore the original behaviour, not a
    // stub: the fetch and the comparison both have to survive.
    const src = read("src/app/api/version/route.js");
    expect(src).toMatch(/registry\.npmjs\.org/);
    expect(src).toMatch(/compareVersions\(latestVersion,\s*currentVersion\)\s*>\s*0/);
  });
});

describe("the banner's install command is never advertised as this build's update", () => {
  it("the sidebar install command comes from UPDATER_CONFIG, so the channel governs it", () => {
    const src = read("src/shared/components/Sidebar.js");
    expect(src).toMatch(/UPDATER_CONFIG\.installCmdLatest/);
  });

  it("the banner is only reached through a truthy hasUpdate", () => {
    const src = read("src/shared/components/Sidebar.js");
    expect(src).toMatch(/if\s*\(data\.hasUpdate\)\s*setUpdateInfo\(data\)/);
  });
});
