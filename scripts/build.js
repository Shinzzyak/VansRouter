#!/usr/bin/env node
// Cross-platform production build for the VansAI app.
//
// Why this script exists:
//   On Windows, something in the Next.js build pipeline recursively globs the
//   user profile (HOME / USERPROFILE / APPDATA / LOCALAPPDATA). The legacy
//   compatibility junctions there ("Application Data", "Local Settings", ...)
//   are reparse points that throw `EPERM: scandir` and crash the build with an
//   unhandledRejection. The fix (mirrors cli/scripts/build-cli.js) is to point
//   those env vars at an empty local `.fakehome` dir for the duration of the
//   build, so the globs scan a clean, junction-free directory.
//
//   It also copies `public/` and `.next/static` into `.next/standalone` using
//   Node's fs API so the exact same command works on Windows and Linux (no `cp`).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { fixStandaloneSymlinks } = require("./fix-standalone-symlinks.cjs");

const appDir = path.resolve(__dirname, "..");
const fakeHome = path.join(appDir, ".fakehome");

// Safety net: back up the production database BEFORE the build wipes .next/.
// The DB lives at DATA_DIR (env or ~/.9router) — outside .next/ so `next build`
// does NOT delete it. But if someone mis-configures DATA_DIR to point inside
// .next/, or if a future change moves the DB, this backup prevents data loss.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function backupProductionDb() {
  const dotenv = loadEnvFile(path.join(appDir, ".env"));
  const dataDir = process.env.DATA_DIR || dotenv.DATA_DIR || process.env.VANSROUTER_DATA_DIR || "/home/ubuntu/VansRouter/data";
  const dbFile = path.join(dataDir, "db", "data.sqlite");
  if (!fs.existsSync(dbFile)) {
    console.log(`▶ DB safety backup skipped (no DB at ${dbFile})`);
    return;
  }
  const backupsDir = path.join(dataDir, "db", "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.join(backupsDir, `pre-build-${stamp}.sqlite`);
  try {
    fs.copyFileSync(dbFile, dest);
    console.log(`▶ DB safety backup: ${dest}`);
  } catch (e) {
    console.warn(`⚠️  DB backup failed (non-fatal): ${e.message}`);
  }
}

// ── Production-host guard ────────────────────────────────────────────────────
//
// WHY THIS EXISTS. `next build` clears `.next/` at the start, and
// `.next/standalone` lives inside it — that directory is the cwd of the live PM2
// process. Building on the router host therefore DELETES THE RUNNING ROUTER,
// while `/api/health` keeps answering 200 the whole time (it is served from
// memory), so the outage looks like a clean build. It happened twice
// (2026-09-19 and 2026-09-24), both times because the operator followed a Quick
// Start that had no idea which machine it was running on.
//
// A rule in a document is a suggestion. This is a wall: the build refuses to
// start, whatever an agent believes it read.
//
// Deploy goes through GitHub Actions, which builds the artifact on a runner and
// ships the tarball here; the VPS only unpacks and restarts. If a local build is
// genuinely wanted on a host that also runs a router, set
// VANSROUTER_ALLOW_LOCAL_BUILD=1 — deliberately explicit, never a default.
function assertNotProductionHost() {
  if (process.env.VANSROUTER_ALLOW_LOCAL_BUILD === "1") {
    console.warn("⚠️  VANSROUTER_ALLOW_LOCAL_BUILD=1 — production-host guard bypassed on purpose.");
    return;
  }
  let live = null;
  try {
    const out = execFileSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
    const list = JSON.parse(out);
    live = (Array.isArray(list) ? list : []).find(
      (p) => p?.pm2_env?.status === "online" && path.resolve(p?.pm2_env?.pm_cwd || "\u0000") === appDir,
    );
  } catch {
    // No pm2, or jlist unreadable: not a managed router host. Carry on — this
    // guard must never be the reason a normal dev build fails.
    return;
  }
  if (!live) return;
  console.error("");
  console.error("REFUSING TO BUILD: this checkout IS the running router.");
  console.error(`  pm2 process : ${live.name} (online, cwd ${live.pm2_env.pm_cwd})`);
  console.error(`  building in : ${appDir}`);
  console.error("");
  console.error("`next build` wipes .next/, and .next/standalone is that process's cwd.");
  console.error("Running it here deletes the live router while /api/health still returns 200.");
  console.error("");
  console.error("Deploy through CI instead:");
  console.error("  git push origin main");
  console.error("  gh run watch -R Shinzzyak/VansRouter");
  console.error("");
  console.error("Already broken? Re-extract the last CI artifact — do not rebuild.");
  console.error("  gh run download <run-id> -R Shinzzyak/VansRouter -n vansrouter-deploy");
  console.error("");
  console.error("Override only if you truly mean it: VANSROUTER_ALLOW_LOCAL_BUILD=1");
  process.exit(3);
}
assertNotProductionHost();

backupProductionDb();

// Run focused no-undef lint before building so "X is not defined" runtime
// crashes are caught early (e.g., GitHub Issue #1, OpenCode CLI setup).
console.log("▶ running no-undef lint");
execFileSync(process.execPath, [path.join(appDir, "scripts", "lint-undef.cjs")], {
  stdio: "inherit",
  cwd: appDir,
});

// Empty, junction-free HOME for the build.
fs.mkdirSync(path.join(fakeHome, "AppData", "Roaming"), { recursive: true });
fs.mkdirSync(path.join(fakeHome, "AppData", "Local"), { recursive: true });

const env = {
  ...process.env,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  APPDATA: path.join(fakeHome, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(fakeHome, "AppData", "Local"),
  // Windows: Next.js traces into TMP/TEMP too. Point them at .fakehome
  // so Cookies / Application Data junctions are never scanned (#EPERM).
  TMP: fakeHome,
  TEMP: fakeHome,
};

// Resolve Next's CLI entry and run it via the current Node binary (avoids
// .cmd/shell quoting differences across platforms).
const nextBin = require.resolve("next/dist/bin/next");

console.log(`▶ next build --webpack  (HOME=${fakeHome})`);
// execFileSync throws on a non-zero exit, which propagates build failure correctly.
execFileSync(process.execPath, [nextBin, "build", "--webpack"], {
  stdio: "inherit",
  cwd: appDir,
  env,
});

// Copy static assets into the standalone output.
// Respect NEXT_DIST_DIR like next.config.mjs does (used by CLI builds).
const distDir = process.env.NEXT_DIST_DIR || ".next";
console.log(`▶ copying public/ + ${distDir}/static into ${distDir}/standalone`);
fs.cpSync(path.join(appDir, "public"), path.join(appDir, distDir, "standalone", "public"), { recursive: true });
fs.cpSync(path.join(appDir, distDir, "static"), path.join(appDir, distDir, "standalone", distDir, "static"), { recursive: true });

fixStandaloneSymlinks(path.resolve(__dirname, "..", ".next", "standalone"));

// ─── Fix standalone instrumentation import ───────────────────────────────────
// kimchiQuotaReactivation.js uses `import(/* webpackIgnore: true */ "../../lib/localDb.js")`
// which webpack rewrites relative to the output chunk (.next/server/chunks/).
// From there, `../../lib/localDb.js` resolves to `.next/lib/localDb.js` — a file
// that doesn't exist because webpack bundles localDb + its deps into server chunks
// for normal routes, but the webpackIgnore prevents bundling for the instrumentation path.
// Fix: copy src/lib/ into standalone and create a @/ alias shim so the runtime import resolves.
const standaloneDir = path.join(appDir, distDir, "standalone");
const srcLibDir = path.join(appDir, "src", "lib");
const standaloneSrcLibDir = path.join(standaloneDir, "src", "lib");
const standaloneNextLibDir = path.join(standaloneDir, distDir, "lib");

// Copy ALL of src/ into standalone (needed for instrumentation + MITM server runtime).
// MITM server.js lives at src/mitm/ and requires relative imports like ./logger,
// plus cross-references like ../../shared/constants/mitmToolHosts.js.
const srcAppDir = path.join(appDir, "src");
const standaloneSrcDir = path.join(standaloneDir, "src");
if (fs.existsSync(srcAppDir)) {
  console.log(`▶ copying src/ into ${distDir}/standalone/src/ (instrumentation + MITM runtime)`);
  fs.cpSync(srcAppDir, standaloneSrcDir, { recursive: true });
}

if (fs.existsSync(srcLibDir)) {
  // Create .next/lib/localDb.js shim — resolves the webpackIgnore dynamic import
  // that webpack rewrites as `../../lib/localDb.js` relative to .next/server/chunks/.
  fs.mkdirSync(standaloneNextLibDir, { recursive: true });
  // The instrumentation chunk uses `import("../../lib/localDb.js")` (dynamic ESM import).
  // Webpack rewrites this relative to .next/server/chunks/ → resolves to .next/lib/localDb.js.
  // We need a package.json with "type":"module" here so Node treats .js as ESM.
  fs.writeFileSync(
    path.join(standaloneNextLibDir, "package.json"),
    JSON.stringify({ type: "module" }),
    "utf8"
  );
  // Also create package.json in standalone/src to fix performance overhead warning on other esm files in standalone
  fs.writeFileSync(
    path.join(standaloneDir, "src", "package.json"),
    JSON.stringify({ type: "module" }),
    "utf8"
  );
  // Copy src/mitm/ into standalone (MITM server.js needs relative imports: ./logger, ./config, etc.)
  const srcMitmDir = path.join(appDir, "src", "mitm");
  const standaloneMitmDir = path.join(standaloneDir, "src", "mitm");
  if (fs.existsSync(srcMitmDir)) {
    fs.cpSync(srcMitmDir, standaloneMitmDir, { recursive: true });
    console.log(`▶ copied src/mitm/ into ${distDir}/standalone/src/mitm/ for MITM runtime`);
  }
  // localDb.js re-exports everything from src/lib/db/index.js (ESM barrel file).
  const shimContent = `// Auto-generated by build.js — resolves webpackIgnore import in instrumentation hook\n` +
    `export {\n` +
    `  getSettings, updateSettings, isCloudEnabled, getCloudUrl,\n` +
    `  getProviderConnections, getProviderConnectionById,\n` +
    `  createProviderConnection, updateProviderConnection,\n` +
    `  deleteProviderConnection, deleteProviderConnectionsByProvider,\n` +
    `  reorderProviderConnections, cleanupProviderConnections,\n` +
    `  getProviderNodes, getProviderNodeById,\n` +
    `  createProviderNode, updateProviderNode, deleteProviderNode,\n` +
    `  getProxyPools, getProxyPoolById,\n` +
    `  createProxyPool, updateProxyPool, deleteProxyPool,\n` +
    `  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,\n` +
    `  getCombos, getComboById, getComboByName,\n` +
    `  createCombo, updateCombo, deleteCombo,\n` +
    `  getModelAliases, setModelAlias, deleteModelAlias,\n` +
    `  getCustomModels, addCustomModel, deleteCustomModel,\n` +
    `  getMitmAlias, setMitmAliasAll,\n` +
    `  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,\n` +
    `  exportDb, importDb,\n` +
    `} from "../../src/lib/db/index.js";\n`;
  fs.writeFileSync(path.join(standaloneNextLibDir, "localDb.js"), shimContent, "utf8");
  console.log(`▶ created ${distDir}/lib/localDb.js shim for instrumentation hook`);
}

console.log("✅ build complete");
