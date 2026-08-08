// Bulk-import browser engine — VansRouter variant (chromium-only).
// Rewritten from grouter's version: drops the wyxrouter/grouter runtime-helper
// loader (cli/hooks/*) — we import playwright-core directly (already a
// dependency). Engine matrix (camoufox/patchright/cloakbrowser) intentionally
// NOT ported (YAGNI POC; registry SUPPORTED_ENGINES keeps the slot).
import { chromium as playwrightChromium } from "playwright-core";

const SUPPORTED_ENGINES = new Set(["chromium"]);
export const DEFAULT_BULK_IMPORT_ENGINE = "chromium";

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

export async function launchBulkImportBrowser({ engine = DEFAULT_BULK_IMPORT_ENGINE, proxyUrl, headless = true, args = [] } = {}) {
  const normalized = normalizeBulkImportEngine(engine);
  if (normalized !== "chromium") {
    throw new Error(`Engine "${normalized}" not supported in this build (chromium only)`);
  }
  return launchChromium({ proxyUrl, headless, args });
}

export function makeBrowserLauncher({ engine, proxyUrl, headless, args } = {}) {
  return () => launchBulkImportBrowser({ engine, proxyUrl, headless, args });
}
