import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";

export const STORAGE_NAME = "qoder-signup-bulk-import";
const QODER_PROVIDER_ID = "qoder";
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

async function saveQoderSignupConnection({ token, email, displayName }) {
  const connection = await createProviderConnection({
    provider: QODER_PROVIDER_ID,
    authType: "oauth",
    accessToken: token,
    email,
    displayName,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "device",
      loginEmail: email,
      automation: "qoder-signup",
    },
  });
  return connection;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("Qoder signup connection save returned no id");
  const saved = await getProviderConnectionById(connection.id);
  if (!saved) throw new Error(`Qoder signup connection ${connection.id} missing after save`);
  return saved;
}

class QoderBulkSignupManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveQoderSignupConnection,
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
      throw new Error("Qoder signup: registerCount > 0 required");
    }
    if (!yydsApiKey || !yydsDomain) {
      throw new Error("Qoder signup: yydsApiKey and yydsDomain required");
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
      `Worker ${workerId} python -m qoderreg register`
    );
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = [
      "-m",
      "qoderreg",
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

    if (this._spawnQoderReg) {
      const captured = await this._spawnQoderReg(args, env, SCRIPT_DIR);
      await this._handleQoderRegOutput(job, account, captured);
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
            // Python may exit non-zero but still print JSON on stdout
            if (stdout && String(stdout).trim().startsWith("{")) {
              resolve(stdout);
              return;
            }
            if (err.killed) {
              reject(new Error(`Qoder signup timed out after ${SIGNUP_TIMEOUT_MS}ms`));
            } else {
              const errMsg = (stdout || stderrFull || stderr || err.message || "").slice(0, 2000);
              reject(new Error(`Qoder signup exit ${err.code}: ${errMsg}`));
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
      await this._handleQoderRegOutput(job, account, { stdout, stderr: "" });
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

  async _handleQoderRegOutput(job, account, { stdout, stderr = "" }) {
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
      throw new Error(`No JSON result from qoderreg: ${String(stdout).slice(0, 200)}`);
    }

    if (result.status === "ok" || result.status === "success") {
      const token = result.token || result.access_token || result.accessToken;
      const email = result.email || account.email;
      if (!token) {
        this.finalizeAccount(account, "failed", {
          error: "Register OK but no token returned",
          step: "signup_missing_token",
          message: "qoderreg did not return a token",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      account.email = email;
      this.setAccountStep(account, "saving_connection", "Saving Qoder connection");
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
        message: `Qoder connection saved ${email}`,
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
      error: result.error || "Qoder signup failed",
      step: "signup_failed",
      message: result.error || "Qoder signup failed",
    });
    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

function getSingletonStore() {
  if (!globalThis.__qoderBulkSignupSingleton) {
    globalThis.__qoderBulkSignupSingleton = {
      manager: new QoderBulkSignupManager(),
    };
  }
  return globalThis.__qoderBulkSignupSingleton;
}

export function getQoderBulkSignupManager() {
  return getSingletonStore().manager;
}

export { QoderBulkSignupManager };
