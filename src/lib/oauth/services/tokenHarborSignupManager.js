import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";

export const STORAGE_NAME = "tokenharbor-signup-bulk-import";
const TH_PROVIDER_ID = "tokenharbor";
const SIGNUP_TIMEOUT_MS = 20 * 60_000;
const MAX_REGISTER_COUNT = 50;

function findPythonBinary() {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return "python3";
}

const PYTHON_BIN = findPythonBinary();

async function saveTokenHarborConnection({ token, email, displayName, inviteCode }) {
  const connection = await createProviderConnection({
    provider: TH_PROVIDER_ID,
    authType: "apikey",
    accessToken: token,
    email,
    displayName,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "apikey",
      loginEmail: email,
      automation: "tokenharbor-signup",
      inviteCode: inviteCode || null,
    },
  });
  return connection;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("Token Harbor signup connection save returned no id");
  const saved = await getProviderConnectionById(connection.id);
  if (!saved) throw new Error(`Token Harbor connection ${connection.id} missing after save`);
  return saved;
}

class TokenHarborSignupManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveTokenHarborConnection,
    assertPersisted = assertConnectionPersisted,
  } = {}) {
    super({
      browserLauncher: async () => ({ close: async () => {}, __ninerouterProxyUrl: null }),
      googleAutomation: null,
      socialExchange: null,
      storageName,
    });
    this.saveConnection = saveConnection;
    this.assertPersisted = assertPersisted;
  }

  async startJob({
    registerCount,
    concurrency,
    yydsApiKey,
    yydsDomain,
    seedInvite,
    proxyUrl,
    headless,
    jobFields,
  }) {
    const count = Math.max(0, Math.min(MAX_REGISTER_COUNT, Number(registerCount) || 0));
    if (!count) {
      throw new Error("Token Harbor signup: registerCount > 0 required");
    }
    if (!yydsApiKey) {
      throw new Error("Token Harbor signup: yydsApiKey required");
    }
    const placeholders = Array.from({ length: count }, (_, i) => ({
      line: i + 1,
      email: `pending-${i + 1}@placeholder`,
      password: crypto.randomUUID(),
      mode: "register",
    }));
    return super.startJob({
      accounts: placeholders.map((a) => `${a.email}|${a.password}`),
      concurrency: concurrency || 1,
      engine: "chromium",
      headless: headless ?? false,
      proxyUrl,
      jobFields: {
        ...(jobFields || {}),
        accountsMeta: placeholders,
        registerCount: count,
        yydsApiKey,
        yydsDomain,
        seedInvite: seedInvite || "",
      },
    });
  }

  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job?._pythonChildren) {
      for (const child of job._pythonChildren.values()) {
        if (child && !child.killed && child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }
      job._pythonChildren.clear();
    }
    return super.cancelJob(jobId);
  }

  async processAccount(job, account, workerId) {
    if (job.cancelRequested) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    const SCRIPT_DIR = path.join(process.cwd(), "scripts", "python");
    const cancelKey = `python-${account.line ?? account.email}`;

    this.setAccountStep(
      account,
      "python_automation",
      `Worker ${workerId} python -m tokenharborreg`
    );
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = [
      "-m",
      "tokenharborreg",
      "--count",
      "1",
      "--yyds-api-key",
      job.yydsApiKey,
    ];
    if (job.yydsDomain) args.push("--yyds-domain", job.yydsDomain);
    if (job.seedInvite) args.push("--seed-invite", job.seedInvite);
    if (job.proxyUrl) args.push("--proxy", job.proxyUrl);
    this.setAccountStep(account, "python_spawn", args.join(" "));

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      YYDS_API_KEY: job.yydsApiKey,
    };

    let stderrFull = "";
    const childPromise = new Promise((resolve, reject) => {
      const child = execFile(
        PYTHON_BIN,
        args,
        { cwd: SCRIPT_DIR, env, timeout: SIGNUP_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (stderr) {
            for (const line of String(stderr).split("\n")) {
              const match = line.match(/\[(\w+)\]\s+(.+)/);
              if (match) this.setAccountStep(account, match[1], match[2].trim());
            }
          }
          if (err) {
            if (stdout && String(stdout).trim().startsWith("{")) {
              resolve(stdout);
              return;
            }
            if (err.killed) {
              reject(new Error(`Token Harbor signup timed out after ${SIGNUP_TIMEOUT_MS}ms`));
            } else {
              const errMsg = (stdout || stderrFull || stderr || err.message || "").slice(0, 2000);
              reject(new Error(`Token Harbor signup exit ${err.code}: ${errMsg}`));
            }
            return;
          }
          resolve(stdout);
        }
      );

      let stderrBuf = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderrBuf += chunk;
        stderrFull += chunk;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() || "";
        for (const line of lines) {
          const match = line.match(/\[(\w+)\]\s+(.+)/);
          if (match) this.setAccountStep(account, match[1], match[2].trim());
        }
      });

      job._pythonChildren = job._pythonChildren || new Map();
      job._pythonChildren.set(cancelKey, child);
    });

    try {
      const stdout = await childPromise;
      await this._handleTokenHarborOutput(job, account, { stdout, stderr: "" });
    } catch (error) {
      this.finalizeAccount(account, "failed", {
        error: `Python error: ${error.message}`,
        step: "python_subprocess_failed",
        message: error.message,
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      account.password = undefined;
      const child = job._pythonChildren?.get(cancelKey);
      if (child && !child.killed && child.exitCode === null) child.kill("SIGTERM");
      job._pythonChildren?.delete(cancelKey);
    }
  }

  async _handleTokenHarborOutput(job, account, { stdout, stderr = "" }) {
    const lines = String(stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let result = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        result = JSON.parse(lines[i]);
        break;
      } catch {
        /* continue */
      }
    }
    if (!result) {
      throw new Error(`No JSON result from tokenharborreg: ${String(stdout).slice(0, 200)}`);
    }

    if (result.status === "success") {
      const token = result.apiKey || result.key || result.access_token;
      const email = result.email || account.email;
      const inviteCode = result.inviteCode || null;
      if (!token) {
        // account created but key not captured — still save email + invite for chaining
        this.finalizeAccount(account, "needs_manual", {
          error: "Account created but API key not captured",
          step: "key_missing",
          message: `email ${email} invite ${inviteCode || "-"} (manual key fetch)`,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      account.email = email;
      this.setAccountStep(account, "saving_connection", "Saving Token Harbor connection");
      await this.persistJobSnapshot(job, { forcePreview: true });
      const connection = await this.saveConnection({
        token,
        email,
        displayName: email.split("@")[0],
        inviteCode,
      });
      await this.assertPersisted(connection);

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: `Token Harbor connection saved ${email}${inviteCode ? ` (invite ${inviteCode})` : ""}`,
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    if (result.status === "cancelled") {
      this.finalizeAccount(account, "cancelled", {
        error: result.error || "cancelled",
        step: "cancelled",
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    this.finalizeAccount(account, "failed", {
      error: result.error || "Token Harbor signup failed",
      step: "signup_failed",
      message: result.error || "Token Harbor signup failed",
    });
    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

function getSingletonStore() {
  if (!globalThis.__tokenHarborSignupSingleton) {
    globalThis.__tokenHarborSignupSingleton = {
      manager: new TokenHarborSignupManager(),
    };
  }
  return globalThis.__tokenHarborSignupSingleton;
}

export function getTokenHarborSignupManager() {
  return getSingletonStore().manager;
}

export { TokenHarborSignupManager };
