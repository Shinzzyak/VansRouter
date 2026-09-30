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
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
