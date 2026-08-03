#!/usr/bin/env node
// Production launcher for the Next.js standalone server.
//
// The standalone server (node .next/standalone/server.js) does NOT auto-load a
// .env file — Next.js only does that for `next dev`/`next start`. So when PM2
// starts this file, env vars like INITIAL_PASSWORD/JWT_SECRET that live in the
// repo .env are never picked up, and the app falls back to its insecure
// defaults (e.g. INITIAL_PASSWORD=123456). Load them here, before the
// standalone server module is required (same process, so it inherits them).
//
// Existing process env (set by PM2 / the real environment) wins and is NOT
// overridden — same precedence as dotenv's default.

const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding single/double quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Load repo-root .env (and .env.local if present) relative to this launcher.
const root = __dirname;
loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, ".env.local"));

// Default VansRoute production port to 3003 when PORT env is not set.
// The standalone Next.js server otherwise falls back to 3000.
// Use PORT=20127 for `pnpm dev` (development server).
process.env.PORT ||= "3003";

require("./.next/standalone/server.js");
