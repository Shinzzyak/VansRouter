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
    // Lower maxConcurrency to prevent SQLite lock contention during full suite runs
    maxConcurrency: 10,
    // Suppress noisy console output from handlers under test
    silent: false,
    env: {
      API_KEY_SECRET: "test-api-key-secret-for-ci-only",
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
