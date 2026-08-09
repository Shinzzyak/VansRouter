import { describe, it, expect } from "vitest";
import {
  QoderBulkSignupManager,
  getQoderBulkSignupManager,
  STORAGE_NAME,
} from "../../src/lib/oauth/services/qoderBulkSignupManager.js";

describe("qoderBulkSignupManager", () => {
  it("exports singleton and storage name", () => {
    const m = getQoderBulkSignupManager();
    expect(m).toBeInstanceOf(QoderBulkSignupManager);
    expect(STORAGE_NAME).toBe("qoder-signup-bulk-import");
    expect(m.storageDir.endsWith("qoder-signup-bulk-import")).toBe(true);
  });

  it("startJob validates registerCount and yyds params", async () => {
    const m = getQoderBulkSignupManager();
    await expect(m.startJob({ registerCount: 0 })).rejects.toThrow(/registerCount > 0/);
    await expect(m.startJob({ registerCount: 2 })).rejects.toThrow(/yydsApiKey and yydsDomain/);
  });

  it("processAccount spawns qoderreg with expected args", async () => {
    const m = getQoderBulkSignupManager();
    const spawned = [];
    m._spawnQoderReg = (args, env) => {
      spawned.push({ args, env });
      return { stdout: JSON.stringify({ status: "success", token: "t", email: "x@y.z" }), stderr: "" };
    };
    const job = {
      cancelRequested: false,
      yydsApiKey: "key-123",
      yydsDomain: "example.com",
      proxyUrl: "http://user:sid-abc@127.0.0.1:8080",
      headless: true,
      _pythonChildren: new Map(),
      persistJobSnapshot: async () => {},
    };
    const account = { line: 1, email: "pending-1@placeholder", password: "pw", status: "queued", logs: [] };
    m.setAccountStep = (a, step, msg) => { a.currentStep = step; a.stepMsg = msg; };
    m.finalizeAccount = (a, status, extras) => { a.status = status; Object.assign(a, extras); };

    const result = await m.processAccount(job, account, "w1");
    expect(result).toBeUndefined();
    const call = spawned[0];
    expect(call.args[0]).toBe("-m");
    expect(call.args[1]).toBe("qoderreg");
    expect(call.args[2]).toBe("register");
    expect(call.args).toContain("--count");
    expect(call.args[call.args.indexOf("--count") + 1]).toBe("1");
    expect(call.args).toContain("--yyds-api-key");
    expect(call.args[call.args.indexOf("--yyds-api-key") + 1]).toBe("key-123");
    expect(call.args).toContain("--yyds-domain");
    expect(call.args[call.args.indexOf("--yyds-domain") + 1]).toBe("example.com");
    expect(call.args).toContain("--proxy");
    expect(call.args[call.args.indexOf("--proxy") + 1]).toBe(job.proxyUrl);
    expect(call.args).toContain("--headless");
    expect(call.env.PYTHONUNBUFFERED).toBe("1");
    expect(call.env.YYDS_API_KEY).toBe("key-123");
  });

  it("saves connection from JSON stdout token", async () => {
    const saved = [];
    const m = new QoderBulkSignupManager({
      saveConnection: async (data) => {
        saved.push(data);
        return { id: "conn-1" };
      },
      assertPersisted: async (connection) => connection,
    });
    m._spawnQoderReg = async () => ({
      stdout: JSON.stringify({
        status: "success",
        token: "tok-abc-123",
        email: "new.user@qoder.com",
        displayName: "New User",
      }),
      stderr: "",
    });
    const job = {
      cancelRequested: false,
      yydsApiKey: "key-123",
      yydsDomain: "example.com",
      _pythonChildren: new Map(),
      persistJobSnapshot: async () => {},
    };
    const account = { line: 1, email: "pending-1@placeholder", password: "pw", status: "queued", logs: [] };
    m.setAccountStep = (a, step, msg) => { a.currentStep = step; a.stepMsg = msg; };
    m.finalizeAccount = (a, status, extras) => { a.status = status; Object.assign(a, extras); };

    await m.processAccount(job, account, "w1");
    expect(account.status).toBe("success");
    expect(account.step).toBe("connection_saved");
    expect(account.connectionId).toBe("conn-1");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      token: "tok-abc-123",
      email: "new.user@qoder.com",
      displayName: "New User",
    });
  });
});
