// Save TokenHarbor connection ke providerConnections (account pool + providers page)
// Usage: node save-tokenharbor-connection.mjs <email> <password> [inviteCode] [apiKey]
// DATA_DIR optional — default: /home/ubuntu/VansRouter/data (lihat save-connection-common.mjs)
import { loadConnectionRepo } from "../save-connection-common.mjs";

const { createProviderConnection } = await loadConnectionRepo();

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
