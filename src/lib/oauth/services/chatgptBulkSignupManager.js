import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KiroBulkImportManager } from "./kiroBulkImportManager.js";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../../models/index.js";

export const STORAGE_NAME = "chatgpt-signup-bulk-import";
const CHATGPT_PROVIDER_ID = "chatgpt";
const SIGNUP_TIMEOUT_MS = 20 * 60_000;
const MAX_REGISTER_COUNT = 50;

function findBinary() {
  const candidates = [
    path.join(process.cwd(), "scripts", "outlook-autoreg", "..", "chatgptreg"),
    "/opt/chatgpt-creator/chatgptreg",
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return "/opt/chatgpt-creator/chatgptreg";
}

const BIN = findBinary();

async function saveChatGptSignupConnection({ email, password, displayName }) {
  const connection = await createProviderConnection({
    provider: CHATGPT_PROVIDER_ID,
    authType: "password",
    accessToken: "",
    email,
    displayName: displayName || email.split("@")[0],
    testStatus: "active",
    providerSpecificData: {
      authMethod: "password",
      loginEmail: email,
      password,
      automation: "chatgpt-signup",
    },
  });
  return connection;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("ChatGPT signup connection save returned no id");
  const saved = await getProviderConnectionById(connection.id);
  if (!saved) throw new Error(`ChatGPT signup connection ${connection.id} missing after save`);
  return saved;
}

class ChatGptBulkSignupManager extends KiroBulkImportManager {
  constructor({
    storageName = STORAGE_NAME,
    saveConnection = saveChatGptSignupConnection,
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
    tempMailApi,
    tempMailToken,
    jobFields,
  }) {
    const count = Math.max(0, Math.min(MAX_REGISTER_COUNT, Number(registerCount) || 0));
    if (!count) {
      throw new Error("ChatGPT signup: registerCount > 0 required");
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
        tempMailApi,
        tempMailToken,
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

    const REPO_DIR = path.dirname(BIN);
    const cancelKey = `python-${account.line ?? account.email}`;

    this.setAccountStep(
      account,
      "go_automation",
      `Worker ${workerId} chatgptreg (Go binary)`
    );
    await this.persistJobSnapshot(job, { forcePreview: false });

    // chatgptreg is interactive (stdin prompts): proxy → total → workers → password → domain
    // We run count=1 per account so results.txt has exactly one new line per invocation.
    const stdinInput = [
      job.proxyUrl || "", // proxy (enter = skip)
      "1", // total accounts
      "1", // max workers
      "", // default password (random)
      "", // default domain (random from temp-mail)
    ].join("\n") + "\n";

    this.setAccountStep(account, "go_spawn", `${BIN} (stdin pipe)`);

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      TEMPMAIL_API: job.tempMailApi || process.env.TEMPMAIL_API || "",
      TEMPMAIL_TOKEN: job.tempMailToken || process.env.TEMPMAIL_TOKEN || "",
      PROXY: job.proxyUrl || "",
    };

    const resultsFile = path.join(REPO_DIR, "results.txt");
    const before = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, "utf8") : "";

    const childPromise = new Promise((resolve, reject) => {
      const child = execFile(
        BIN,
        [],
        { cwd: REPO_DIR, env, timeout: SIGNUP_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            reject(new Error(`ChatGPT signup exit ${err.code}: ${(stderr || err.message || "").slice(0, 2000)}`));
            return;
          }
          resolve(stdout);
        }
      );
      child.stdin?.write(stdinInput);
      child.stdin?.end();
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        const lines = String(chunk).split("\n");
        for (const line of lines) {
          const match = line.match(/\[(\w+)\]\s+(.+)/);
          if (match) this.setAccountStep(account, match[1], match[2].trim());
          else if (line.includes("SUCCESS") || line.includes("FAILURE")) {
            this.setAccountStep(account, "go_progress", line.trim().slice(0, 200));
          }
        }
      });
      job._pythonChildren = job._pythonChildren || new Map();
      job._pythonChildren.set(cancelKey, child);
    });

    try {
      await childPromise;
      await this._handleChatGptRegOutput(job, account, { before, resultsFile, REPO_DIR });
    } catch (error) {
      // Non-zero exit but may still have written results.txt
      try {
        await this._handleChatGptRegOutput(job, account, { before, resultsFile, REPO_DIR });
      } catch (inner) {
        this.finalizeAccount(account, "failed", {
          error: `Go error: ${error.message}${inner ? ` / ${inner.message}` : ""}`,
          step: "go_subprocess_failed",
          message: error.message,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
      }
    } finally {
      account.password = undefined;
      const child = job._pythonChildren?.get(cancelKey);
      if (child && !child.killed && child.exitCode === null) child.kill("SIGTERM");
      job._pythonChildren?.delete(cancelKey);
    }
  }

  async _handleChatGptRegOutput(job, account, { before, resultsFile }) {
    if (!fs.existsSync(resultsFile)) {
      throw new Error(`No results.txt after chatgptreg run`);
    }
    const after = fs.readFileSync(resultsFile, "utf8");
    const newLines = after.split("\n").filter((l) => !before.includes(l) && l.includes("|"));
    if (newLines.length === 0) {
      throw new Error(`chatgptreg did not write a new account line (check proxy/IP flags)`);
    }

    // Last new line wins (in case of concurrent jobs)
    const last = newLines[newLines.length - 1].trim();
    const [email, password] = last.split("|");
    if (!email || !password) {
      this.finalizeAccount(account, "failed", {
        error: "chatgptreg wrote malformed line",
        step: "signup_incomplete",
        message: last,
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    account.email = email;
    this.setAccountStep(account, "saving_connection", "Saving ChatGPT connection");
    await this.persistJobSnapshot(job, { forcePreview: true });

    const connection = await this.saveConnection({
      email,
      password,
      displayName: email.split("@")[0],
    });
    await this.assertPersisted(connection);

    this.finalizeAccount(account, "success", {
      connectionId: connection.id,
      step: "connection_saved",
      message: `ChatGPT connection saved ${email}`,
    });
    await this.persistJobSnapshot(job, { forcePreview: true });
  }
}

function getSingletonStore() {
  if (!globalThis.__chatgptBulkSignupSingleton) {
    globalThis.__chatgptBulkSignupSingleton = {
      manager: new ChatGptBulkSignupManager(),
    };
  }
  return globalThis.__chatgptBulkSignupSingleton;
}

export function getChatGptBulkSignupManager() {
  return getSingletonStore().manager;
}
