#!/usr/bin/env node
// Save AutoClaw token into VansRouter providerConnections (called by autoclawreg CLI).
// Usage: node save-autoclaw-connection.mjs <json-payload>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createProviderConnection } from "../../../src/lib/db/repos/connectionsRepo.js";

// Resolve DATA_DIR the same way the app does: env DATA_DIR, else ~/.9router
function resolveDataDir() {
  const configured = process.env.DATA_DIR;
  if (configured && fs.existsSync(configured)) return configured;
  return path.join(os.homedir(), ".9router");
}
process.env.DATA_DIR = resolveDataDir();

const payload = JSON.parse(process.argv[2]);

try {
  const conn = await createProviderConnection({
    provider: "autoclaw",
    authType: "access_token",
    name: payload.user_name || String(payload.user_id || "autoclaw-import"),
    email: payload.email || String(payload.user_id || "unknown"),
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    testStatus: "active",
    lastRefreshAt: new Date().toISOString(),
    providerSpecificData: {
      deviceId: payload.device_id,
      userName: payload.user_name,
      source: "autoclawreg",
      importedAt: new Date().toISOString(),
    },
  });
  console.log(JSON.stringify({ ok: true, id: conn?.id }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
}
