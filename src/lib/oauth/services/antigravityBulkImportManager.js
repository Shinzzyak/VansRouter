import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const STORAGE_NAME = "antigravity-bulk-import";

const ANTIGRAVITY_PROVIDER_ID = "antigravity";
const MAX_IMPORT_COUNT = 300;

export function parseAntigravityBulkAccounts(accounts = []) {
  const lines = Array.isArray(accounts) ? accounts : [];
  const parsed = [];
  const invalidLines = [];

  lines.forEach((line, index) => {
    const raw = String(line || "").trim();
    if (!raw) return;
    if (raw.startsWith("#")) return;

    let email = "";
    let password = "";

    if (raw.includes("|")) {
      const [emailPart = "", ...passwordParts] = raw.split("|");
      email = emailPart.trim();
      password = passwordParts.join("|").trim();
    } else if (raw.includes("\t")) {
      const tabIdx = raw.indexOf("\t");
      email = raw.substring(0, tabIdx).trim();
      password = raw.substring(tabIdx + 1).trim();
    } else if (raw.includes(":")) {
      const colonIdx = raw.indexOf(":");
      const beforeColon = raw.substring(0, colonIdx).trim();
      if (beforeColon.includes("@")) {
        email = beforeColon;
        password = raw.substring(colonIdx + 1).trim();
      }
    }

    if (!email || !password) {
      invalidLines.push(index + 1);
      return;
    }

    parsed.push({
      line: index + 1,
      email,
      password,
    });
  });

  return { parsed, invalidLines };
}

export async function saveAntigravityConnection({
  accessToken,
  refreshToken,
  email,
  displayName,
  expiresIn = 3599,
  cloudProjectId = null,
  projectId = null,
}) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const connection = await createProviderConnection({
    provider: ANTIGRAVITY_PROVIDER_ID,
    authType: "oauth",
    name: displayName || (email ? email.split("@")[0] : "Antigravity Account"),
    email,
    accessToken,
    refreshToken,
    expiresAt,
    expiresIn,
    cloudProjectId: cloudProjectId || "opportune-voltage-xds98",
    projectId: projectId || "opportune-voltage-xds98",
    testStatus: "active",
    providerSpecificData: {
      automation: "antigravity-gsuite-bulk",
    },
  });
  return connection;
}

export class AntigravityBulkImportManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveAntigravityConnection,
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

    this.setAccountStep(account, "starting_auth", `Worker ${workerId} is authenticating ${account.email}`);
    await this.persistJobSnapshot(job, { forcePreview: true });

    try {
      const scriptPath = path.resolve(process.cwd(), "scripts/python/antigravityreg/antigravity_auth.py");
      
      const tokenDir = path.join(os.homedir(), ".gemini/antigravity-cli");
      const tokenFilesBefore = new Set(
        fs.existsSync(tokenDir) ? fs.readdirSync(tokenDir).filter((f) => f.startsWith("antigravity-oauth-token")) : []
      );

      const proc = spawn("python3", [scriptPath, account.email, account.password], {
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        },
      });

      let stdout = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
        const lines = stdout.split("\n");
        const last = lines[lines.length - 2] || "";
        if (last.includes("AGY:") || last.includes("GOT_CODE")) {
          this.setAccountStep(account, "running_flow", last.slice(0, 80));
        }
      });

      const exitCode = await new Promise((resolve) => {
        proc.on("close", resolve);
        proc.on("error", () => resolve(-1));
      });

      const tokenFilesAfter = fs.existsSync(tokenDir)
        ? fs.readdirSync(tokenDir).filter((f) => f.startsWith("antigravity-oauth-token"))
        : [];
      
      const newTokens = tokenFilesAfter.filter((f) => !tokenFilesBefore.has(f));
      const targetTokenFile = newTokens[0] || (tokenFilesAfter.length > 0 ? tokenFilesAfter[0] : null);

      if (!targetTokenFile || exitCode !== 0) {
        throw new Error(`Authentication script failed (exit ${exitCode}) or no token file generated`);
      }

      const tokenData = JSON.parse(fs.readFileSync(path.join(tokenDir, targetTokenFile), "utf8"));
      const flatTokenData = tokenData?.token
        ? { ...tokenData, ...tokenData.token }
        : tokenData;
      if (!flatTokenData.access_token && !flatTokenData.accessToken) {
        throw new Error("Invalid token payload extracted");
      }

      this.setAccountStep(account, "saving_connection", "Saving Antigravity connection to database");
      await this.persistJobSnapshot(job, { forcePreview: true });

      const connection = await this.saveConnection({
        accessToken: flatTokenData.access_token || flatTokenData.accessToken,
        refreshToken: flatTokenData.refresh_token || flatTokenData.refreshToken,
        email: account.email,
        displayName: account.email.split("@")[0],
        expiresIn: flatTokenData.expires_in || 3599,
      });

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: "Antigravity OAuth connection created successfully",
      });
    } catch (err) {
      this.finalizeAccount(account, "failed", {
        error: err.message || "Antigravity bulk auth failed",
      });
    }

    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

let _singleton = null;
export function getAntigravityBulkImportManager() {
  if (!_singleton) _singleton = new AntigravityBulkImportManager();
  return _singleton;
}
