import https from "https";
import pkg from "../../../../package.json" with { type: "json" };
import { UPDATER_CONFIG } from "@/shared/constants/config";

// Keep aligned with the published package. Do not revert to legacy `9router`: it reports obsolete versions.
const NPM_PACKAGE_NAME = "vansrouter";
const VERSION_CACHE_TTL_MS = 300000; // cache npm latest lookup for 5m

// Is the npm check meaningful for THIS build?
//
// It is not, for the licence-gated pack: `vansrouter` on npm is upstream's
// package, so a version comparison can only ever produce an install command that
// replaces this build with upstream. See UPDATER_CONFIG.updateChannel.
//
// The check is skipped rather than the banner being hidden in the UI: the route
// is what the dashboard and any script reads, and a fork must not advertise a
// command that overwrites it. `latestVersion` stays null so callers can tell
// "not checked" from "checked, up to date".
const UPDATE_CHECK_ENABLED = UPDATER_CONFIG.updateChannel === "npm";

// Survive hot reload; one cache per process
const versionCache = (global.__npmVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch latest version from npm registry
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
      { timeout: 4000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getLatestVersionCached() {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const latestVersion = UPDATE_CHECK_ENABLED ? await getLatestVersionCached() : null;
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({
    currentVersion,
    latestVersion,
    hasUpdate,
    updateChannel: UPDATER_CONFIG.updateChannel,
    buildId: process.env.RELEASE_BUILD_ID || null,
  });
}
