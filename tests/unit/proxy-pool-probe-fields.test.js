// A proxy-pool probe result has to survive the round trip to disk.
//
// The dashboard reads pools through the list endpoint, which reads the row back
// through the repo. A probe that persists latency in a shape the read path does
// not surface looks exactly like a probe that never ran — a silent failure. So
// this asserts the read path, not the write call: the write is the easy half.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-proxy-pool-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("proxy pool probe fields", () => {
  it("latency and lastTestedAt survive a probe write and a re-read", async () => {
    const created = await db.createProxyPool({ name: "probe-a", proxyUrl: "http://127.0.0.1:1/" });
    const testedAt = new Date().toISOString();

    await db.updateProxyPool(created.id, {
      testStatus: "active",
      lastTestedAt: testedAt,
      latency: 412,
      lastError: null,
      isActive: true,
    });

    const back = await db.getProxyPoolById(created.id);
    expect(back.testStatus).toBe("active");
    expect(back.lastTestedAt).toBe(testedAt);
    expect(back.latency).toBe(412);
  });

  it("a failed probe keeps latency 0 — a missing measurement, not a dropped field", async () => {
    const created = await db.createProxyPool({ name: "probe-b", proxyUrl: "http://127.0.0.1:2/" });

    await db.updateProxyPool(created.id, {
      testStatus: "error",
      lastTestedAt: new Date().toISOString(),
      latency: 0,
      lastError: "connect ECONNREFUSED 127.0.0.1:2",
      isActive: false,
    });

    const back = await db.getProxyPoolById(created.id);
    // 0 is a real value here. Any `||` or truthiness check on the way out would
    // turn "probe ran and measured nothing" back into "never probed".
    expect(back.latency).toBe(0);
    expect(back.testStatus).toBe("error");
    expect(back.isActive).toBe(false);
    expect(back.lastError).toMatch(/ECONNREFUSED/);
  });

  it("the list read path surfaces the same fields the probe wrote", async () => {
    const list = await db.getProxyPools();
    const row = list.find((p) => p.name === "probe-a");
    expect(row).toBeTruthy();
    expect(row.latency).toBe(412);
    expect(row.lastTestedAt).toBeTruthy();
    expect(row.testStatus).toBe("active");
  });

  it("an untested pool reports no latency rather than a fabricated 0", async () => {
    const created = await db.createProxyPool({ name: "probe-untested", proxyUrl: "http://127.0.0.1:3/" });
    const back = await db.getProxyPoolById(created.id);
    expect(back.lastTestedAt).toBeNull();
    expect(back.latency).toBeUndefined();
  });
});
