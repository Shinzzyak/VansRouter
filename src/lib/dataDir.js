import fs from "node:fs";
import path from "path";
import os from "os";

// APP_NAME must match the data directory used by the DB driver.
// Do not rename — this controls where ~/.<APP_NAME>/db/data.sqlite lives.
const APP_NAME = "9router" + "";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  // VansRouter deployment default. The decommissioned ~/.9router must NEVER be
  // used as a fallback — it holds a stale DB and silently swallows writes.
  // Home-relative so builds on CI (home=/home/runner, read-only /home/ubuntu)
  // don't crash collecting page data; prod sets VANSROUTER_DATA_DIR.
  return (
    process.env.VANSROUTER_DATA_DIR ||
    path.join(os.homedir(), "VansRouter", "data")
  );
  // legacy default: /home/ubuntu/VansRouter/data — keep via env on prod
}

function looksLikeSmokeDataDir(configured) {
  const normalized = configured.toLowerCase().replace(/\\/g, "/");
  // Explicit smoke-test directories used by CI / local smoke scripts.
  if (normalized.includes("smoke")) return true;
  if (/^\/tmp\/9router-data-/.test(normalized)) return true;
  // macOS sandbox temp paths are never intended for persistent DB storage.
  if (process.platform === "darwin" && normalized.includes("/var/folders/")) return true;
  return false;
}

function isProductionLike() {
  // Only consider actual production runtime:
  // - NODE_ENV explicitly set to production
  // - process is managed by PM2 (pm_id is set)
  // Do NOT use PM2_HOME because many dev shells have PM2 installed, which would
  // falsely flag local tests/development as production.
  return process.env.NODE_ENV === "production" || process.env.pm_id !== undefined;
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // Prevent production/PM2 deployments from accidentally using a smoke-test or
  // temp directory as the persistent data store. A temp DATA_DIR means the DB
  // appears "empty" after reboot/cleanup and real data in ~/.9router is ignored.
  if (looksLikeSmokeDataDir(configured)) {
    const fallback = defaultDir();
    if (isProductionLike()) {
      console.warn(
        `[DATA_DIR] '${configured}' looks like a temp/smoke directory; ` +
          `using persistent default '${fallback}' instead. ` +
          `Set DATA_DIR to an explicit persistent path (e.g. /app/data) to override.`
      );
      return fallback;
    }
    console.warn(
      `[DATA_DIR] '${configured}' looks like a temp/smoke directory; ` +
        `continuing because NODE_ENV is not production and PM2 is not detected. ` +
        `Use a persistent path in production to avoid data loss.`
    );
  }

  return configured;
}

export const DATA_DIR = getDataDir();
