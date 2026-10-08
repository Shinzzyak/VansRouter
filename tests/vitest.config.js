import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan nested agent/git worktrees — they carry their own copies of
    // tests but lack the root dependency context.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/.kilo/**", "**/.git/**", "**/dist/**", "**/all-endpoints-robust.test.js"],
    maxConcurrency: 10,
    testTimeout: 15000,
    pool: "threads",
    // Suppress noisy console output from handlers under test
    silent: false,
    env: {
      API_KEY_SECRET: "test-api-key-secret-for-ci-only",
      // Hermetic data dir. dataDir.js reads DATA_DIR first; without this every
      // test that transitively opens the DB lands on /home/ubuntu/VansRouter/data
      // and mutates the LIVE sqlite (it added a column once — see registry K21).
      // Tests that need isolation still override process.env.DATA_DIR themselves.
      DATA_DIR: resolve(__dirname, "../.tmp-test-data"),
    },
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      // data/engine/src is a build-time copy of the private engine repo, and the
      // engine sources import six PUBLIC plumbing modules by relative path —
      // files that only exist in open-sse/rtk. CI copies the private sources into
      // data/engine/src but never the plumbing, so any gate whose import closure
      // enters that zone dies on ERR_MODULE_NOT_FOUND at COLLECT time (CI run
      // 37707979051: refusalAttribution.js gained `import { SEAL_LINE } from
      // "./brandContract.js"` in e72e081, which turned a leaf into a consumer).
      // Aliasing is the same move run-engine-suite.sh makes with its sed rewrite:
      // one source of truth, no duplicated public code, no drift.
      ...[
        "brandContract", "caveman", "contentWalk",
        "formatInjectors", "ponytail", "systemInject",
      ].map((m) => ({
        find: new RegExp(`^\\./${m}\\.js$`),
        replacement: resolve(__dirname, `../open-sse/rtk/${m}.js`),
      })),
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
