// Save TokenHarbor connection ke providerConnections (account pool + providers page)
// Usage: DATA_DIR=<db-dir> node save-tokenharbor-connection.mjs <email> <password> [inviteCode] [apiKey]
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

const [email, password, inviteCode, apiKey] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: save-tokenharbor-connection.mjs <email> <password> [inviteCode] [apiKey]");
  process.exit(1);
}

const conn = await createProviderConnection({
  provider: "tokenharbor",
  authType: "apikey",
  accessToken: apiKey || null,
  email,
  displayName: email.split("@")[0],
  testStatus: apiKey ? "active" : "needs_verify",
  providerSpecificData: {
    authMethod: "apikey",
    loginEmail: email,
    loginPassword: password,
    ...(inviteCode ? { inviteCode } : {}),
    ...(apiKey ? { apiKey } : {}),
  },
});

console.log(JSON.stringify({ ok: true, id: conn.id, provider: "tokenharbor", email, status: conn.testStatus }));
