import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";
import { findPythonBinary } from "./pythonEnv.js";

export const STORAGE_NAME = "outlook-signup-bulk-import";
const OUTLOOK_PROVIDER_ID = "outlook";
const SIGNUP_TIMEOUT_MS = 20 * 60_000;
const MAX_REGISTER_COUNT = 50;

const PYTHON_BIN = findPythonBinary();

async function saveOutlookSignupConnection({ email, password, refreshToken, clientId, accessToken }) {
  const connection = await createProviderConnection({
    provider: OUTLOOK_PROVIDER_ID,
    authType: "oauth",
    accessToken: refreshToken || accessToken || "",
    email,
    displayName: email.split("@")[0],
    testStatus: "active",
    providerSpecificData: {
      authMethod: "oauth",
      loginEmail: email,
      password,
      refreshToken: refreshToken || "",
      clientId: clientId || "",
      automation: "outlook-signup",
    },
  });
  return connection;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("Outlook signup connection save returned no id");
  const saved = await getProviderConnectionById(connection.id);
  if (!saved) throw new Error(`Outlook signup connection ${connection.id} missing after save`);
  return saved;
}

class OutlookBulkSignupManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveOutlookSignupConnection,
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
    proxyUrl,
    mode,
    yydsApiKey,
    jobFields,
  }) {
    const count = Math.max(0, Math.min(MAX_REGISTER_COUNT, Number(registerCount) || 0));
    if (!count) {
      throw new Error("Outlook signup: registerCount > 0 required");
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
      proxyUrl,
      jobFields: {
        ...(jobFields || {}),
        accountsMeta: placeholders,
        registerCount: count,
        outlookMode: mode || "auto",
        yydsApiKey: yydsApiKey || "",
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

    const REPO_DIR = path.join(process.cwd(), "scripts", "outlook-autoreg");
    const cancelKey = `python-${account.line ?? account.email}`;

    this.setAccountStep(
      account,
      "python_automation",
      `Worker ${workerId} register_outlook.py`
    );
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = [
      "register_outlook.py",
      "--count",
      "1",
      "--concurrency",
      "1",
      "--mode",
      job.outlookMode || "auto",
    ];
    if (job.proxyUrl) {
      const proxyFile = path.join(REPO_DIR, "proxy_tmp.txt");
      fs.writeFileSync(proxyFile, job.proxyUrl.replace(/^https?:\/\//, "") + "\n");
      args.push("--proxy-file", proxyFile);
    } else {
      args.push("--no-proxy");
    }
    this.setAccountStep(account, "python_spawn", args.join(" "));

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      OUTLOOK_NO_BITBROWSER: "1",
      CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY || "",
      EZCAPTCHA_API_KEY: process.env.EZCAPTCHA_API_KEY || "",
      SMS5SIM_TOKEN: process.env.SMS5SIM_TOKEN || "",
      SMSPOOL_KEY: process.env.SMSPOOL_KEY || "",
      // YYDS mail API key — dibutuhkan recovery mailbox (graph token flow).
      // Tanpa ini register_outlook.py fallback ke config (kosong) → ValueError.
      // Fix: re-chatgpt-outlook 2026-08-10 — di-pass dari startJob (registry fallback settings).
      YYDS_API_KEY: process.env.YYDS_API_KEY || job.jobFields?.yydsApiKey || "",
    };

    if (this._spawnOutlookReg) {
      const captured = await this._spawnOutlookReg(args, env, REPO_DIR);
      await this._handleOutlookRegOutput(job, account, captured);
      return;
    }

    let stderrFull = "";
    const childPromise = new Promise((resolve, reject) => {
      const child = execFile(
        PYTHON_BIN,
        args,
        { cwd: REPO_DIR, env, timeout: SIGNUP_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            reject(new Error(`Outlook signup exit ${err.code}: ${(stderr || err.message || "").slice(0, 2000)}`));
            return;
          }
          resolve(stdout);
        }
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderrFull += chunk;
        const lines = String(chunk).split("\n");
        for (const line of lines) {
          const match = line.match(/\[(\w+)\]\s+(.+)/);
          if (match) this.setAccountStep(account, match[1], match[2].trim());
        }
      });
      job._pythonChildren = job._pythonChildren || new Map();
      job._pythonChildren.set(cancelKey, child);
    });

    try {
      await childPromise;
      await this._handleOutlookRegOutput(job, account, { stderr: stderrFull });
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

  async _handleOutlookRegOutput(job, account, { stderr = "" }) {
    // register_outlook.py writes accounts_<ts>.txt under outlook_accounts/ with
    // format: email----password----refresh_token----client_id (per live account)
    const REPO_DIR = path.join(process.cwd(), "scripts", "outlook-autoreg");
    const outDir = path.join(REPO_DIR, "outlook_accounts");
    let newestFile = null;
    let newestMtime = 0;
    try {
      if (fs.existsSync(outDir)) {
        for (const f of fs.readdirSync(outDir)) {
          if (!f.startsWith("accounts_") || !f.endsWith(".txt")) continue;
          const fp = path.join(outDir, f);
          // Skip 0-byte files (attempt failed before writing any line) — filter
          // by size > 0 supaya error path tidak termakan file kosong.
          // Fix: re-chatgpt-outlook 2026-08-10.
          let size = 0;
          try {
            size = fs.statSync(fp).size;
          } catch {
            continue;
          }
          if (size === 0) continue;
          const m = fs.statSync(fp).mtimeMs;
          if (m > newestMtime) {
            newestMtime = m;
            newestFile = fp;
          }
        }
      }
    } catch {
      /* no output dir yet */
    }

    if (!newestFile) {
      throw new Error(`No outlook accounts file found: ${(stderr || "").slice(0, 300)}`);
    }

    const lines = fs.readFileSync(newestFile, "utf8").split("\n").filter(Boolean);
    // Find the line for OUR email (last successful write wins)
    let matched = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const parts = lines[i].split("----");
      if (parts.length >= 2 && parts[0].includes("@")) {
        matched = parts;
        break;
      }
    }

    if (!matched) {
      throw new Error(`No account line in ${newestFile}: ${(stderr || "").slice(0, 300)}`);
    }

    const [email, password, refreshToken, clientId] = matched;
    if (!email || !password) {
      this.finalizeAccount(account, "failed", {
        error: "Outlook register incomplete (missing email/password)",
        step: "signup_incomplete",
        message: "register_outlook did not produce email+password",
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    account.email = email;
    this.setAccountStep(account, "saving_connection", "Saving Outlook connection");
    await this.persistJobSnapshot(job, { forcePreview: true });

    const connection = await this.saveConnection({
      email,
      password,
      refreshToken: refreshToken || "",
      clientId: clientId || "",
    });
    await this.assertPersisted(connection);

    this.finalizeAccount(account, "success", {
      connectionId: connection.id,
      step: "connection_saved",
      message: `Outlook connection saved ${email}`,
    });
    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

function getSingletonStore() {
  if (!globalThis.__outlookBulkSignupSingleton) {
    globalThis.__outlookBulkSignupSingleton = {
      manager: new OutlookBulkSignupManager(),
    };
  }
  return globalThis.__outlookBulkSignupSingleton;
}

export function getOutlookBulkSignupManager() {
  return getSingletonStore().manager;
}
