import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "@/lib/db/repos/connectionsRepo.js";
import { findPythonBinary } from "./pythonEnv.js";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import { DEFAULT_BULK_IMPORT_ENGINE } from "./bulkImportBrowserEngine.js";

const STORAGE_NAME = "llm7-signup-jobs";
const LLM7_PROVIDER_ID = "llm7";
const SIGNUP_TIMEOUT_MS = 8 * 60_000;
const MAX_REGISTER_COUNT = 50;

const PYTHON_BIN = findPythonBinary();

async function saveLlm7Connection({ token, email, displayName }) {
  const connection = await createProviderConnection({
    provider: LLM7_PROVIDER_ID,
    authType: "apikey",
    accessToken: token,
    email,
    displayName,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "apikey",
      loginEmail: email,
      automation: "llm7-signup",
    },
  });
  return connection;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("LLM7 signup connection save returned no id");
  const saved = await getProviderConnectionById(connection.id);
  if (!saved) throw new Error(`LLM7 connection ${connection.id} missing after save`);
  return saved;
}

class Llm7SignupManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveLlm7Connection,
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
    headless,
    jobFields,
  }) {
    const count = Math.max(0, Math.min(MAX_REGISTER_COUNT, Number(registerCount) || 0));
    if (!count) {
      throw new Error("LLM7 signup: registerCount > 0 required");
    }
    if (!yydsApiKey) {
      throw new Error("LLM7 signup: yydsApiKey required");
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
      engine: DEFAULT_BULK_IMPORT_ENGINE,
      headless: headless ?? false,
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
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
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
      `Worker ${workerId} python -m llm7reg`
    );
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = [
      "-m",
      "llm7reg",
      "--count",
      "1",
      "--yyds-api-key",
      job.yydsApiKey,
    ];
    if (job.yydsDomain) args.push("--yyds-domain", job.yydsDomain);
    // Turnstile invisible only passes via Camoufox+WARP — default to WARP unless explicit proxy
    args.push("--proxy", job.proxyUrl || "socks5://127.0.0.1:40000");
    this.setAccountStep(account, "python_spawn", args.join(" "));

    const env = {
      ...process.env,
      PYTHONPATH: SCRIPT_DIR,
      PYTHONUNBUFFERED: "1",
      YYDS_API_KEY: job.yydsApiKey,
    };

    let stderrFull = "";
    const childPromise = new Promise((resolve, reject) => {
      const child = execFile(
        PYTHON_BIN,
        args,
        {
          cwd: SCRIPT_DIR,
          env,
          timeout: SIGNUP_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          detached: true, // own process group → SIGTERM kills camoufox children too
        },
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
              reject(new Error(`LLM7 signup timed out after ${SIGNUP_TIMEOUT_MS}ms`));
            } else {
              const errMsg = (stdout || stderrFull || stderr || err.message || "").slice(0, 2000);
              reject(new Error(`LLM7 signup exit ${err.code}: ${errMsg}`));
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
      await this._handleLlm7Output(job, account, { stdout, stderr: "" });
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
      if (child && !child.killed && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM"); // negative pid = whole group
        } catch {
          child.kill("SIGTERM");
        }
      }
      job._pythonChildren?.delete(cancelKey);
    }
  }

  async _handleLlm7Output(job, account, { stdout, stderr = "" }) {
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
      throw new Error(`No JSON result from llm7reg: ${String(stdout).slice(0, 200)}`);
    }

    if (result.status === "success") {
      const token = result.apiKey;
      const email = result.email || account.email;
      if (!token) {
        this.finalizeAccount(account, "needs_manual", {
          error: "Account created but API key not captured",
          step: "key_missing",
          message: `email ${email} (manual key fetch at dash.llm7.io)`,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      account.email = email;
      this.setAccountStep(account, "saving_connection", "Saving LLM7 connection");
      await this.persistJobSnapshot(job, { forcePreview: true });
      const connection = await this.saveConnection({
        token,
        email,
        displayName: email.split("@")[0],
      });
      await this.assertPersisted(connection);

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: `email ${email} key ${token.slice(0, 8)}…`,
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    if (result.status === "needs_verify" || result.status === "needs_manual") {
      this.finalizeAccount(account, "needs_verify", {
        error: result.error || "Account created but needs manual attention",
        step: result.status,
        message: `${result.email || account.email}: ${result.error || ""}`.slice(0, 300),
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    this.finalizeAccount(account, "failed", {
      error: result.error || "LLM7 signup failed",
      step: "signup_failed",
      message: String(result.error || "").slice(0, 300),
    });
    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

let _singleton = null;
export function getLlm7SignupManager() {
  if (!_singleton) _singleton = new Llm7SignupManager();
  return _singleton;
}
