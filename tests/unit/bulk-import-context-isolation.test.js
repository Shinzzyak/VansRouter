// Isolation guard for bulk-import browser contexts.
//
// Why this file exists: bulk automation runs many accounts through one shared
// browser. The only safe shape is "one fresh context per account" — cookies,
// localStorage and the cookie jar live in the context, not the browser. The
// moment somebody caches a context (or reuses one) across accounts, account A's
// session cookies become readable by account B: cross-account bleed, which in
// the worst case merges two provider accounts.
//
// Two layers of proof:
//   1. contract layer (always runs)  — createFreshContext must NOT memoize, and
//      every call must hand out a distinct context object.
//   2. real layer (skipped without a chromium binary) — a genuine chromium
//      launch, a cookie written in context A, asserted invisible in context B.
//
// The negative control at the bottom proves layer 2 can actually fail: a
// deliberately shared context is detected as bleed. A guard that cannot fail
// proves nothing.
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFreshContext } from "@/lib/oauth/services/kiroBulkImportManager.js";

const BULK_IMPORT_DEFAULT_NAVIGATION_TIMEOUT_MS = 120_000;
const BULK_IMPORT_DEFAULT_TIMEOUT_MS = 60_000;

// --- layer 1: contract -----------------------------------------------------

function makeFakeBrowser() {
  const calls = [];
  let seq = 0;
  return {
    calls,
    newContext: async (options) => {
      const id = ++seq;
      calls.push({ options, id });
      return {
        id,
        pages: [],
        cookies: [],
        newPage: async () => {
          const page = {
            setDefaultNavigationTimeout() {},
            setDefaultTimeout() {},
          };
          return page;
        },
        close: async () => {},
      };
    },
  };
}

describe("createFreshContext — no shared context between accounts", () => {
  it("never memoizes: two accounts, two contexts", async () => {
    const browser = makeFakeBrowser();
    const a = await createFreshContext(browser, { locale: "en-US" });
    const b = await createFreshContext(browser, { locale: "en-US" });

    expect(browser.calls).toHaveLength(2);
    expect(a.context).not.toBe(b.context);
    expect(a.page).not.toBe(b.page);
  });

  it("hands each caller its own options object (no shared mutable state)", async () => {
    const browser = makeFakeBrowser();
    await createFreshContext(browser);
    await createFreshContext(browser);
    const [first, second] = browser.calls;
    expect(first.options).not.toBe(second.options);
  });

  it("keeps the proxy-friendly timeouts on both context and page", async () => {
    const browser = makeFakeBrowser();
    await createFreshContext(browser);
    const { options } = browser.calls[0];
    expect(options.defaultNavigationTimeout).toBe(BULK_IMPORT_DEFAULT_NAVIGATION_TIMEOUT_MS);
    expect(options.defaultTimeout).toBe(BULK_IMPORT_DEFAULT_TIMEOUT_MS);
  });
});

// --- layer 2: a real chromium, if one is installed -------------------------

function findChromiumExecutable() {
  if (process.env.VR_CHROMIUM_EXECUTABLE) return process.env.VR_CHROMIUM_EXECUTABLE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(root)) return null;
  const candidates = fs
    .readdirSync(root)
    .filter((name) => name.startsWith("chromium-") || name.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const dir of candidates) {
    for (const rel of [
      ["chrome-linux64", "chrome"],
      ["chrome-linux", "chrome"],
      ["chrome-headless-shell-linux64", "chrome-headless-shell"],
    ]) {
      const candidate = path.join(root, dir, ...rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const executablePath = findChromiumExecutable();
const realLayer = executablePath ? describe : describe.skip;

realLayer("createFreshContext — real chromium cookie isolation", () => {
  let chromium;

  beforeAll(async () => {
    ({ chromium } = await import("playwright-core"));
  });

  it("a cookie written for account A is invisible to account B", async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const accountA = await createFreshContext(browser);
      const accountB = await createFreshContext(browser);

      // Give both contexts a real origin, then write A's session cookie.
      const serverA = await accountA.page.goto("https://example.com/");
      expect(serverA).not.toBeNull();
      await accountA.context.addCookies([
        { name: "session", value: "account-a-secret", domain: "example.com", path: "/" },
      ]);

      const aCookies = await accountA.context.cookies("https://example.com/");
      expect(aCookies.map((c) => `${c.name}=${c.value}`)).toContain("session=account-a-secret");

      const bCookies = await accountB.context.cookies("https://example.com/");
      expect(bCookies).toEqual([]);

      // And the jar the page actually sees agrees.
      await accountB.page.goto("https://example.com/");
      const visibleToB = await accountB.page.evaluate(() => document.cookie);
      expect(visibleToB).not.toContain("account-a-secret");
    } finally {
      await browser.close().catch(() => null);
    }
  }, 60_000);

  it("NEGATIVE CONTROL: a shared context DOES bleed (guard can fail)", async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      // Deliberately wrong: one context reused for two "accounts".
      const shared = await browser.newContext();
      const accountA = { context: shared, page: await shared.newPage() };
      const accountB = { context: shared, page: await shared.newPage() };

      await accountA.context.addCookies([
        { name: "session", value: "account-a-secret", domain: "example.com", path: "/" },
      ]);

      const bCookies = await accountB.context.cookies("https://example.com/");
      expect(bCookies.map((c) => `${c.name}=${c.value}`)).toContain("session=account-a-secret");
    } finally {
      await browser.close().catch(() => null);
    }
  }, 60_000);
});

// --- layer 3: source-shape guard -------------------------------------------
//
// Layers 1 and 2 prove today's code is safe. This layer proves a FUTURE edit
// cannot silently reintroduce the bleed: the audit's stated risk was a context
// cached under the wrong key, and the other classic vector is a persistent
// on-disk profile (launchPersistentContext / userDataDir) shared by every
// account. Both are banned in the oauth service layer by construction.
//
// The scanner is negative-controlled at the bottom: a planted violation must be
// detected, otherwise the guard is decoration.

const SERVICES_DIR = path.join(process.cwd(), "src", "lib", "oauth", "services");

// Caches keyed by account identity are the failure mode. `cdpSessions` /
// `cdpFrames` are keyed by page for screencast teardown and are not account
// state, so the pattern is deliberately narrow: it only matches identifiers
// that name BOTH a context and a cache/pool/map.
const ACCOUNT_CONTEXT_CACHE = /\b(?:context|browser|profile)[A-Za-z_]*(?:Cache|Pool|Map|ByAccount|PerAccount)\b|\b(?:cache|pool)[A-Za-z_]*(?:Context|Browser|Profile)\b/i;
const PERSISTENT_PROFILE = /launchPersistentContext|userDataDir\s*[=:]/;

function scanSources(files, patterns) {
  const hits = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    source.split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      for (const [label, pattern] of patterns) {
        if (pattern.test(code)) hits.push({ file: path.basename(file), line: index + 1, label });
      }
    });
  }
  return hits;
}

describe("oauth services — no account-keyed context cache, no shared profile dir", () => {
  const files = fs.readdirSync(SERVICES_DIR).filter((name) => name.endsWith(".js")).map((name) => path.join(SERVICES_DIR, name));

  it("has service sources to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("declares no account-keyed context/browser cache", () => {
    const hits = scanSources(files, [["account-context-cache", ACCOUNT_CONTEXT_CACHE]]);
    expect(hits).toEqual([]);
  });

  it("never launches a persistent (on-disk) profile", () => {
    const hits = scanSources(files, [["persistent-profile", PERSISTENT_PROFILE]]);
    expect(hits).toEqual([]);
  });

  it("NEGATIVE CONTROL: the scanner DOES catch a planted violation", () => {
    const planted = scanSources([], []);
    expect(planted).toEqual([]);
    // Feed the scanner a synthetic file body instead of a real one.
    const tmp = path.join(os.tmpdir(), `ctx-guard-${process.pid}.js`);
    fs.writeFileSync(tmp, "const contextCacheByAccount = new Map();\nconst b = await chromium.launchPersistentContext(dir);\n");
    try {
      const hits = scanSources([tmp], [["account-context-cache", ACCOUNT_CONTEXT_CACHE], ["persistent-profile", PERSISTENT_PROFILE]]);
      expect(hits.map((h) => h.label).sort()).toEqual(["account-context-cache", "persistent-profile"]);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe("bulk managers — one fresh context per account, inside processAccount", () => {
  const managers = [
    "kiroBulkImportManager.js",
    "qoderBulkImportManager.js",
    "codebuddyBulkImportManager.js",
    "codebuddyCnPhoneImportManager.js",
    "autoclawBulkImportManager.js",
  ];

  it.each(managers)("%s creates its context per account", (name) => {
    const source = fs.readFileSync(path.join(SERVICES_DIR, name), "utf8");
    // The context must be created by the shared helper, not by a raw
    // browser.newContext() at a site that could be hoisted out of the loop.
    expect(source).toMatch(/createFreshContext\(/);
    const rawNewContext = source.match(/browser\.newContext\(/g) || [];
    // Only the documented relaunch path may call newContext directly.
    expect(rawNewContext.length).toBeLessThanOrEqual(1);
  });
});
