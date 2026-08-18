import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";

export const STORAGE_NAME = "chatgpt-web-bulk-import";
const CHATGPT_WEB_PROVIDER_ID = "chatgpt-web";

export function parseChatGptWebBulkAccounts(accounts = []) {
  const lines = Array.isArray(accounts) ? accounts : [];
  const parsed = [];
  const invalidLines = [];

  lines.forEach((line, index) => {
    const raw = String(line || "").trim();
    if (!raw) return;
    if (raw.startsWith("#")) return;

    // Check JSON object format
    if (raw.startsWith("{") && raw.endsWith("}")) {
      try {
        const obj = JSON.parse(raw);
        const token = obj.accessToken || obj.access_token || obj.apiKey || obj.token;
        const email = obj.email || obj.user?.email || "";
        const accountId = obj.accountId || obj.account_id || "";
        if (token) {
          parsed.push({
            line: index + 1,
            token,
            email,
            accountId,
          });
          return;
        }
      } catch {
        // fallback to line parse
      }
    }

    // Check delimited: email|token or email|token|accountId or bare token
    if (raw.includes("|")) {
      const parts = raw.split("|").map((p) => p.trim());
      if (parts[0].includes("@")) {
        parsed.push({
          line: index + 1,
          email: parts[0],
          token: parts[1],
          accountId: parts[2] || "",
        });
      } else {
        parsed.push({
          line: index + 1,
          email: "",
          token: parts[0],
          accountId: parts[1] || "",
        });
      }
    } else {
      // Bare token or cookie string
      parsed.push({
        line: index + 1,
        email: "",
        token: raw,
        accountId: "",
      });
    }
  });

  return { parsed, invalidLines };
}

export async function saveChatGptWebConnection({ token, email, accountId, displayName }) {
  const isJwt = token.startsWith("eyJ") || token.split(".").length === 3;
  let derivedEmail = email;

  if (!derivedEmail && isJwt) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
      derivedEmail = payload.email || payload["https://api.openai.com/profile"]?.email || "";
    } catch {
      // ignore
    }
  }

  const connection = await createProviderConnection({
    provider: CHATGPT_WEB_PROVIDER_ID,
    authType: "cookie",
    name: displayName || (derivedEmail ? derivedEmail.split("@")[0] : "ChatGPT Web Session"),
    email: derivedEmail || null,
    apiKey: token,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "cookie",
      chatgptAccountId: accountId || null,
      automation: "chatgpt-web-bulk",
    },
  });
  return connection;
}

export class ChatGptWebBulkImportManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveChatGptWebConnection,
  } = {}) {
    super({
      browserLauncher: async () => ({ close: async () => {}, __ninerouterProxyUrl: null }),
      googleAutomation: null,
      socialExchange: null,
      storageName,
    });
    this.saveConnection = saveConnection;
  }

  async processAccount(job, account, workerId) {
    if (job.cancelRequested) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    this.setAccountStep(account, "importing_token", `Saving ChatGPT Web token`);
    await this.persistJobSnapshot(job, { forcePreview: true });

    try {
      if (!account.token) {
        throw new Error("Missing token/cookie");
      }

      const connection = await this.saveConnection({
        token: account.token,
        email: account.email,
        accountId: account.accountId,
      });

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: "ChatGPT Web connection created successfully",
      });
    } catch (err) {
      this.finalizeAccount(account, "failed", {
        error: err.message || "Failed to save ChatGPT Web connection",
      });
    }

    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

let _singleton = null;
export function getChatGptWebBulkImportManager() {
  if (!_singleton) _singleton = new ChatGptWebBulkImportManager();
  return _singleton;
}
