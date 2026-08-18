import crypto from "node:crypto";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";

export const STORAGE_NAME = "freebuff-bulk-import";

const FREEBUFF_PROVIDER_ID = "freebuff";
const MAX_IMPORT_COUNT = 200;

/**
 * Freebuff bulk import — API key = authToken dari device-code approve flow.
 * Pipeline: POST /api/auth/cli/code {fingerprintId} → loginUrl → approve Google SSO
 * → GET /api/auth/cli/status → {user.authToken} (API key).
 * Verified 17-Agu-2026 (sarah.johnson@e-mail.bty.web.id → c30ebda3-...).
 */
async function saveFreebuffConnection({ token, email, displayName, fingerprintId }) {
  const connection = await createProviderConnection({
    provider: FREEBUFF_PROVIDER_ID,
    authType: "oauth",
    accessToken: token,
    email,
    displayName,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "device",
      loginEmail: email,
      fingerprintId,
      automation: "freebuff-import",
    },
  });
  return connection;
}

class FreebuffBulkImportManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveFreebuffConnection,
  } = {}) {
    super({
      browserLauncher: async () => ({ close: async () => {}, __ninerouterProxyUrl: null }),
      googleAutomation: null,
      socialExchange: null,
      storageName,
    });
    this.saveConnection = saveConnection;
  }

  async startJob({
    accounts,
    concurrency = 1,
    proxyUrl,
    engine = "camoufox",
    headless = true,
  }) {
    const list = Array.isArray(accounts) ? accounts : [];
    if (!list.length) throw new Error("Freebuff import: accounts (authToken list) required");
    const limited = list.slice(0, MAX_IMPORT_COUNT);

    let imported = 0;
    const errors = [];
    for (const acct of limited) {
      const token = acct.token || acct.authToken || acct.apiKey;
      const email = acct.email || acct.name || "";
      if (!token) {
        errors.push(`${acct.email || "?"}: no token`);
        continue;
      }
      try {
        const conn = await this.saveConnection({
          token,
          email,
          displayName: email || `freebuff-${imported + 1}`,
          fingerprintId: acct.fingerprintId || crypto.randomUUID(),
        });
        if (!conn?.id) throw new Error("save returned no id");
        const saved = await getProviderConnectionById(conn.id);
        if (!saved) throw new Error(`connection ${conn.id} missing after save`);
        imported++;
      } catch (e) {
        errors.push(`${email}: ${e.message}`);
      }
    }

    return {
      imported,
      failed: errors.length,
      errors: errors.slice(0, 20),
      done: true,
    };
  }
}

export function parseFreebuffBulkAccounts(raw) {
  // raw: "email|authToken" per baris ATAU "email|authToken|fingerprintId"
  const lines = Array.isArray(raw) ? raw : String(raw || "").split("\n");
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, token, fingerprintId] = line.split(/[|,;\t]/);
      return { email: (email || "").trim(), token: (token || "").trim(), fingerprintId: (fingerprintId || "").trim() };
    })
    .filter((a) => a.token);
}

let _manager;
export function getFreebuffBulkImportManager() {
  if (!_manager) _manager = new FreebuffBulkImportManager();
  return _manager;
}
