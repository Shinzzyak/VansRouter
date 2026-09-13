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

/**
 * Read the `email` claim out of a Google id_token without verifying the
 * signature.
 *
 * We are not authenticating anyone here — Google already did that during the
 * OAuth flow. This is a sanity check that the token we are about to store
 * describes the account we asked for. Returns null when the token cannot be
 * read, so a malformed token never blocks a genuinely successful run.
 */
export function decodeIdTokenEmail(idToken) {
  try {
    const parts = String(idToken).split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

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
      // The agy CLI keeps its OAuth session in this file. If a session from a
      // PREVIOUS account is still on disk, agy signs in silently with it and
      // never prints an auth URL — the script then waits out its 60s window and
      // fails with NO_AUTH_URL for every account after the first. Worse, the
      // token it writes carries the OLD account's identity, so a connection can
      // be filed under the wrong email. Clear the session before every run.
      const sessionFiles = [
        path.join(tokenDir, "antigravity-oauth-token"),
      ];
      for (const f of sessionFiles) {
        try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
      }

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
        // Say which of the two actually happened. The old message blamed the
        // script for "no token file" even when the file was there and the exit
        // code was the real problem — that sent debugging in the wrong
        // direction. agy OVERWRITES one fixed filename, so "a new file
        // appeared" is not a usable success signal.
        const detail = !targetTokenFile
          ? `no token file present in ${tokenDir}`
          : `exit code ${exitCode}`;
        throw new Error(`Authentication script failed: ${detail} (exit ${exitCode}, newFiles=${newTokens.length})`);
      }

      const tokenData = JSON.parse(fs.readFileSync(path.join(tokenDir, targetTokenFile), "utf8"));
      const flatTokenData = tokenData?.token
        ? { ...tokenData, ...tokenData.token }
        : tokenData;
      if (!flatTokenData.access_token && !flatTokenData.accessToken) {
        throw new Error("Invalid token payload extracted");
      }

      // Verify the token belongs to the account we just authenticated.
      // agy reuses whatever session is on disk, so a token for a DIFFERENT
      // account can land here — filing it under this email would point every
      // later request at the wrong quota, and one exhausted account would drag
      // another down with it. The id_token carries the real identity.
      const idToken = flatTokenData.id_token || tokenData?.id_token || null;
      if (idToken) {
        const claimEmail = decodeIdTokenEmail(idToken);
        if (claimEmail && claimEmail.toLowerCase() !== account.email.toLowerCase()) {
          throw new Error(`Token belongs to ${claimEmail}, not ${account.email} — session leaked between accounts`);
        }
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
