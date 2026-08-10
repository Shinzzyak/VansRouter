import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";
import { findPythonBinary } from "./pythonEnv.js";

export const STORAGE_NAME = "baseten-signup-bulk-import";
const BASETEN_PROVIDER_ID = "baseten";
const SIGNUP_TIMEOUT_MS = 20 * 60_000;
const MAX_REGISTER_COUNT = 50;

const PYTHON_BIN = findPythonBinary();

async function saveBasetenConnection({ token, email, displayName }) {
  const connection = await createProviderConnection({
    provider: BASETEN_PROVIDER_ID,
    authType: "apikey",
    accessToken: token,
    email,
    displayName,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "apikey",
      loginEmail: email,
      automation: "baseten-signup",
    },
  });
  return connection;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("Baseten signup connection save returned no id");
  const saved = await getProviderConnectionById(connection.id);
  if (!saved) throw new Error(`Baseten signup connection ${connection.id} missing after save`);
  return saved;
}

class BasetenSignupManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveBasetenConnection,
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
    proxyUrl,
    engine,
    headless,
    jobFields,
  }) {
    const count = Math.max(0, Math.min(MAX_REGISTER_COUNT, Number(registerCount) || 0));
    if (!count) {
      throw new Error("Baseten signup: registerCount > 0 required");
    }
    if (!yydsApiKey) {
      throw new Error("Baseten signup: yydsApiKey required");
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

    this.setAccountStep(
      account,
      "python_automation",
      `Worker ${workerId} python -m basetenreg`
    );
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = [
      "-m",
      "basetenreg",
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

    if (this._spawnBasetenReg) {
      const captured = await this._spawnBasetenReg(args, env, SCRIPT_DIR);
      await this._handleBasetenOutput(job, account, captured);
      return;
    }

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
              reject(new Error(`Baseten signup timed out after ${SIGNUP_TIMEOUT_MS}ms`));
            } else {
              const errMsg = (stdout || stderrFull || stderr || err.message || "").slice(0, 2000);
              reject(new Error(`Baseten signup exit ${err.code}: ${errMsg}`));
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
      await this._handleBasetenOutput(job, account, { stdout, stderr: "" });
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

  async _handleBasetenOutput(job, account, { stdout, stderr = "" }) {
    // Last JSON line wins (upstream may print noise)
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
      throw new Error(`No JSON result from basetenreg: ${String(stdout).slice(0, 200)}`);
    }

    if (result.status === "ok" || result.status === "success") {
      const token = result.api_key || result.apiKey || result.key;
      const email = result.email || account.email;
      if (!token) {
        this.finalizeAccount(account, "failed", {
          error: "Register OK but no API key returned",
          step: "signup_missing_key",
          message: "basetenreg did not return an API key",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      account.email = email;
      this.setAccountStep(account, "saving_connection", "Saving Baseten connection");
      await this.persistJobSnapshot(job, { forcePreview: true });
      const connection = await this.saveConnection({
        token,
        email,
        displayName: result.displayName || result.display_name || email.split("@")[0],
      });
      await this.assertPersisted(connection);

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: `Baseten connection saved ${email}`,
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
      error: result.error || "Baseten signup failed",
      step: "signup_failed",
      message: result.error || "Baseten signup failed",
    });
    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

function getSingletonStore() {
  if (!globalThis.__basetenSignupSingleton) {
    globalThis.__basetenSignupSingleton = {
      manager: new BasetenSignupManager(),
    };
  }
  return globalThis.__basetenSignupSingleton;
}

export function getBasetenSignupManager() {
  return getSingletonStore().manager;
}

export { BasetenSignupManager };
