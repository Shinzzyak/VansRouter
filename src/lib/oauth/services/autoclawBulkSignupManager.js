// AutoClaw bulk signup manager — spawns autoclawreg CLI (Z.ai signup + YYDS temp-mail)
// Pattern mirrors qoderBulkSignupManager.js. Output: JSON lines {status, access_token, refresh_token, device_id, user_id, user_name}.
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";

export const STORAGE_NAME = "autoclaw-signup-bulk-import";
const AUTOCLAW_PROVIDER_ID = "autoclaw";
const SIGNUP_TIMEOUT_MS = 20 * 60_000;

function findPython() {
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
const PYTHON_BIN = findPython();

async function saveAutoclawSignupConnection({ access_token, refresh_token, device_id, user_id, user_name, email }) {
  const device = device_id || crypto.randomUUID();
  const conn = await createProviderConnection({
    provider: AUTOCLAW_PROVIDER_ID,
    authType: "access_token",
    name: user_name || String(user_id || "autoclaw-signup"),
    email: email || String(user_id || "unknown"),
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    testStatus: "active",
    lastRefreshAt: new Date().toISOString(),
    providerSpecificData: {
      deviceId: device,
      source: "autoclawreg",
    },
  });
  return conn;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("AutoClaw signup: no connection id");
  const row = await getProviderConnectionById(connection.id);
  if (!row) throw new Error(`AutoClaw signup: connection ${connection.id} not persisted`);
  return row;
}

export class AutoclawBulkSignupManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveAutoclawSignupConnection,
    assertPersisted = assertConnectionPersisted,
  } = {}) {
    super({
      storageName,
      providerId: AUTOCLAW_PROVIDER_ID,
      browserLauncher: async () => ({ close: async () => {}, __ninerouterProxyUrl: null }),
      googleAutomation: null,
      socialExchange: null,
      saveConnection,
    });
    this.saveConnection = saveConnection;
    this.assertPersisted = assertPersisted;
  }

  async startJob({
    registerCount,
    concurrency,
    yydsApiKey,
    yydsDomain,
    proxyUrl,
    engine,
    headless,
    jobFields,
  }) {
    const count = Math.max(0, Math.min(100, Number(registerCount) || 0));
    if (!count) {
      throw new Error("AutoClaw signup: registerCount > 0 required");
    }
    if (!yydsApiKey) {
      throw new Error("AutoClaw signup: yydsApiKey required");
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
      engine,
      headless,
      proxyUrl,
      jobFields: {
        ...(jobFields || {}),
        accountsMeta: placeholders,
        registerCount: count,
        yydsApiKey,
        yydsDomain,
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

    this.setAccountStep(account, "python_automation", `Worker ${workerId} python -m autoclawreg --count 1`);
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = [
      "-m",
      "autoclawreg",
      "--count",
      "1",
      "--yyds-api-key",
      job.yydsApiKey,
    ];
    if (job.yydsDomain) args.push("--yyds-domain", job.yydsDomain);
    if (job.proxyUrl) args.push("--proxy", job.proxyUrl);
    if (job.engine) args.push("--engine", job.engine);
    if (job.headless) args.push("--headless");
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
              reject(new Error(`AutoClaw signup timed out after ${SIGNUP_TIMEOUT_MS}ms`));
            } else {
              const errMsg = (stdout || stderrFull || stderr || err.message || "").slice(0, 2000);
              reject(new Error(`AutoClaw signup exit ${err.code}: ${errMsg}`));
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
      await this._handleAutoclawRegOutput(job, account, { stdout, stderr: "" });
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

  async _handleAutoclawRegOutput(job, account, { stdout, stderr = "" }) {
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
      throw new Error(`No JSON result from autoclawreg: ${String(stdout).slice(0, 200)}`);
    }

    if (result.status === "ok" || result.status === "success") {
      const accessToken = result.access_token || result.accessToken;
      const email = result.email || account.email;
      if (!accessToken) {
        this.finalizeAccount(account, "failed", {
          error: "Register OK but no access token returned",
          step: "signup_missing_token",
          message: "autoclawreg did not return an access token",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      account.email = email;
      this.setAccountStep(account, "saving_connection", "Saving AutoClaw connection");
      await this.persistJobSnapshot(job, { forcePreview: true });
      const connection = await this.saveConnection({
        access_token: accessToken,
        refresh_token: result.refresh_token || "",
        device_id: result.device_id || "",
        user_id: result.user_id || "",
        user_name: result.user_name || email.split("@")[0],
        email,
      });
      await this.assertPersisted(connection);

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: `AutoClaw connection saved ${email}`,
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
      error: result.error || "AutoClaw signup failed",
      step: "signup_failed",
      message: result.error || "AutoClaw signup failed",
    });
    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

function getSingletonStore() {
  if (!globalThis.__autoclawBulkSignupSingleton) {
    globalThis.__autoclawBulkSignupSingleton = {
      manager: new AutoclawBulkSignupManager(),
    };
  }
  return globalThis.__autoclawBulkSignupSingleton;
}

export function getAutoclawBulkSignupManager() {
  return getSingletonStore().manager;
}

export { AutoclawBulkSignupManager };
