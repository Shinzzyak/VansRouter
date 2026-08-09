// Bulk-import browser engine — VansRouter variant (chromium + camoufox).
// Rewritten from grouter's version: drops the wyxrouter/grouter runtime-helper
// loader (cli/hooks/*) — we import playwright-core directly (already a
// dependency). Camoufox (Firefox patched anti-fingerprint) is the default for
// automation where anti-bot is required (Aliyun TMD, Turnstile); chromium stays
// as a lightweight fallback. Engine matrix (patchright/cloakbrowser)
// intentionally NOT ported (YAGNI POC; registry SUPPORTED_ENGINES keeps slot).
import { chromium as playwrightChromium, firefox as playwrightFirefox } from "playwright-core";

const SUPPORTED_ENGINES = new Set(["chromium", "camoufox"]);
export const DEFAULT_BULK_IMPORT_ENGINE = "camoufox";

export function normalizeBulkImportEngine(value) {
  if (typeof value !== "string") return DEFAULT_BULK_IMPORT_ENGINE;
  const lower = value.trim().toLowerCase();
  return SUPPORTED_ENGINES.has(lower) ? lower : DEFAULT_BULK_IMPORT_ENGINE;
}

export function buildBrowserProxyOption(proxyUrl) {
  const clean = String(proxyUrl || "").trim();
  if (!clean) return null;
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    return null;
  }
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

// Google login pages are bypassed from the proxy: Google aggressively blocks
// automated logins from proxy/ISP IPs (ERR_ABORTED / ERR_CONNECTION_CLOSED).
// The Google OAuth flow runs on the direct IP while provider traffic goes
// through the proxy. Chromium --proxy-bypass-list uses ';' as separator.
const GOOGLE_PROXY_BYPASS_DOMAINS = [
  "*.google.com",
  "*.googleapis.com",
  "*.gstatic.com",
  "*.googleusercontent.com",
  "*.accounts.google.com",
  "*.signin.google.com",
  "*.myaccount.google.com",
].join(";");

function buildProxyBypassArgs(proxyUrl, existingArgs = []) {
  if (!proxyUrl) return existingArgs;
  return [...existingArgs, `--proxy-bypass-list=${GOOGLE_PROXY_BYPASS_DOMAINS}`];
}

async function launchChromium({ proxyUrl, headless = true, args = [] } = {}) {
  const options = { headless };
  const finalArgs = buildProxyBypassArgs(proxyUrl, args);
  if (finalArgs.length) options.args = finalArgs;
  const proxy = buildBrowserProxyOption(proxyUrl);
  if (proxy) options.proxy = proxy;
  return playwrightChromium.launch(options);
}

// Camoufox (patched Firefox anti-fingerprint) lives in the qoderreg venv on
// the server: scripts/python/qoderreg-venv. `camoufox server` (CLI) launches a
// Playwright server and prints "Websocket endpoint: ws://host:port/token".
// We spawn it, parse the endpoint from stdout, then connect with playwright's
// firefox connect. IMPORTANT: the connecting driver must match the server's
// driver version — camoufox uses playwright 1.60 bundled in the venv, while
// the repo's playwright-core may differ. We require() the venv's bundled
// playwright-core driver directly to guarantee protocol compatibility.
// The child must be killed when the browser closes.
async function launchCamoufox({ proxyUrl, headless = true } = {}) {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const { createRequire } = await import("node:module");

  const home = os.homedir();
  const venvSite = path.join(
    home,
    "VansRouter",
    "scripts",
    "python",
    "qoderreg-venv",
    "lib",
    "python3.12",
    "site-packages",
  );
  const camoufoxBin = path.join(venvSite, "..", "..", "..", "bin", "camoufox");
  const driverPackage = path.join(venvSite, "playwright", "driver", "package");
  if (!fs.existsSync(driverPackage)) {
    throw new Error(`Camoufox venv driver not found at ${driverPackage} — install qoderreg-venv on server`);
  }

  const proxy = buildBrowserProxyOption(proxyUrl);

  // `camoufox server` has no args; it launches a headed Firefox, so it needs
  // an X display. We wrap it in xvfb-run (installed on the VPS) when no DISPLAY
  // is set, which gives us a virtual framebuffer. Proxy is not passed through
  // the CLI (no args) — use the python bridge for proxy support instead.
  const needsXvfb = !process.env.DISPLAY;
  const cmd = needsXvfb ? "/usr/bin/xvfb-run" : camoufoxBin;
  const cmdArgs = needsXvfb
    ? ["-a", "-s", "-screen 0 1280x800x24", camoufoxBin, "server"]
    : ["server"];
  const child = spawn(cmd, cmdArgs, {
    // ponytail: no cwd — camoufoxBin is an absolute path; xvfb-run needs
    // nothing from the venv bin dir. Avoids odd ENOENT when the dir is
    // unavailable in constrained runtimes (pm2, systemd).
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      // ensure PATH so xvfb-run can find Xvfb even when parent env is sparse
      PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.CFX_DEBUG) {
    console.error("[cfx-debug] spawn:", cmd, JSON.stringify(cmdArgs));
  }

  // attach error handler IMMEDIATELY — spawn error events fire asynchronously
  // and would be unhandled if we only attach inside the promise below.
  // We also surface the error to the launched promise via spawnError.
  let spawnError = null;
  child.on("error", (err) => {
    spawnError = err;
  });

  const launched = new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("Camoufox server timed out (no ws endpoint)"));
      }
    }, 60_000);
    timer.unref();

    if (spawnError) {
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Camoufox server spawn failed: ${spawnError.message}`));
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      buf += chunk;
      // endpoint printed as: Websocket endpoint:<ESC>[93m ws://host:port/token <ESC>[0m
      // indexOf/split is more robust than regex against ANSI escape variants.
      const idx = buf.indexOf("ws://");
      if (idx !== -1 && !settled) {
        const ws = buf.slice(idx).split(/[^\w:./-]/)[0];
        if (ws) {
          settled = true;
          clearTimeout(timer);
          resolve({ ws, child });
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const m = chunk.match(/Error launching server: (.+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(m[1].trim()));
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Camoufox server exited early (code ${code})`));
      }
    });
  });

  const { ws, child: serverChild } = await launched;
  try {
    // connect with the venv's bundled playwright-core driver (same version as
    // the server — protocol compatibility)
    const requireVenv = createRequire(path.join(driverPackage, "package.json"));
    const venvPlaywright = requireVenv(driverPackage);
    const browser = await venvPlaywright.firefox.connect(ws, { timeout: 30_000 });
    browser.__camoufoxChild = serverChild;
    return browser;
  } catch (error) {
    serverChild.kill("SIGTERM");
    throw new Error(`Camoufox connect failed: ${error.message}`);
  }
}

export async function launchBulkImportBrowser({
  engine = DEFAULT_BULK_IMPORT_ENGINE,
  proxyUrl,
  headless = true,
  args = [],
} = {}) {
  const normalized = normalizeBulkImportEngine(engine);
  if (normalized === "chromium") {
    return launchChromium({ proxyUrl, headless, args });
  }
  if (normalized === "camoufox") {
    try {
      return await launchCamoufox({ proxyUrl, headless });
    } catch (error) {
      throw new Error(`Engine "camoufox" failed to launch: ${error.message}`);
    }
  }
  throw new Error(`Engine "${normalized}" not supported in this build`);
}

export function makeBrowserLauncher({ engine, proxyUrl, headless, args } = {}) {
  return () => launchBulkImportBrowser({ engine, proxyUrl, headless, args });
}
