#!/usr/bin/env node
// Save AutoClaw token into VansRouter providerConnections (called by autoclawreg CLI).
// Usage: node save-autoclaw-connection.mjs <json-payload>
import { loadConnectionRepo } from "../save-connection-common.mjs";

const { createProviderConnection } = await loadConnectionRepo();

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
