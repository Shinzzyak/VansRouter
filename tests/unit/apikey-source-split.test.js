// Resale/endpoint key separation (migration 012).
//
// The Resale page and the Endpoint page share one apiKeys table, but they are
// different inventories. This pins that split against real rows:
//   - migration 012 adds the source column and backfills code-redeemed keys
//   - minting (manual resale mint, code redemption) tags resell keys
//   - getApiKeys({source}) scopes each dashboard surface; the unfiltered read
//     still returns everything (the monitoring page)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-source-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const load = async () => ({
  driver: await import("@/lib/db/driver.js"),
  migrations: await import("@/lib/db/migrations/index.js"),
  keys: await import("@/lib/db/repos/apiKeysRepo.js"),
  redeem: await import("@/lib/db/repos/redeemCodesRepo.js"),
});

describe("migration 012 — the source column and the backfill", () => {
  it("fresh DB lands the source column and stamps v12", async () => {
    const { driver, migrations } = await load();
    const db = await driver.getAdapter();

    const columns = db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(columns).toContain("source");

    const stamped = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(stamped.value, 10)).toBe(migrations.latestVersion());
    expect(migrations.latestVersion()).toBe(12);
  });

  it("backfills: pre-split code-redeemed keys become resell, plain keys stay endpoint", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const m012 = (await import("@/lib/db/migrations/012-add-api-key-source.js")).default;

    const adapter = await createSqlJsAdapter(path.join(tempDir, "backfill.sqlite"));
    // A pre-012 apiKeys table: source does not exist yet.
    adapter.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT,
      machineId TEXT,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT,
      metadata TEXT
    )`);
    adapter.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, metadata) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["r1", "sk-resell-1", "buyer", "m1", 1, new Date().toISOString(),
       JSON.stringify({ redeemCode: "AAAA-BBBB-CCCC", batch: "sunday" })]
    );
    adapter.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, metadata) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["e1", "sk-endpoint-1", "my-key", "m1", 1, new Date().toISOString(), "{}"]
    );

    m012.up(adapter);

    const resellRow = adapter.get(`SELECT source FROM apiKeys WHERE id = 'r1'`);
    const endpointRow = adapter.get(`SELECT source FROM apiKeys WHERE id = 'e1'`);
    expect(resellRow.source).toBe("resell");
    expect(endpointRow.source).toBe(null);
    adapter.close();
  });
});

describe("the split on a real database", () => {
  it("mint tagging: manual resale mint → resell, default mint → endpoint", async () => {
    const { driver, keys } = await load();
    const db = await driver.getAdapter();

    const resellKey = await keys.createApiKey("sold-key", "m1", { source: "resell", tokenBalance: 5_000_000 });
    const endpointKey = await keys.createApiKey("my-key", "m1", { tokenBalance: 2_000_000 });

    expect(db.get(`SELECT source FROM apiKeys WHERE id = ?`, [resellKey.id]).source).toBe("resell");
    expect(db.get(`SELECT source FROM apiKeys WHERE id = ?`, [endpointKey.id]).source).toBe("endpoint");
  });

  it("redeem issues the buyer key as resell", async () => {
    const { driver, redeem, keys } = await load();
    const db = await driver.getAdapter();

    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 3_000_000, extendsDays: 30 });
    const out = await redeem.redeemCode(code.code, { name: "wajib-buyer" });
    expect(out.ok).toBe(true);

    const row = db.get(`SELECT source, metadata FROM apiKeys WHERE id = ?`, [out.key.id]);
    expect(row.source).toBe("resell");
    expect(row.metadata).toContain("redeemCode");
  });

  it("getApiKeys scopes by source; the unfiltered read still returns everything", async () => {
    const { driver, keys, redeem } = await load();

    await keys.createApiKey("endpoint-a", "m1", {});
    await keys.createApiKey("endpoint-b", "m1", {});
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 1_000_000 });
    const out = await redeem.redeemCode(code.code, {});
    expect(out.ok).toBe(true);

    const all = await keys.getApiKeys();
    const resell = await keys.getApiKeys({ source: "resell" });
    const endpoint = await keys.getApiKeys({ source: "endpoint" });

    expect(all).toHaveLength(3);
    expect(resell).toHaveLength(1);
    expect(resell[0].id).toBe(out.key.id);
    expect(endpoint).toHaveLength(2);
    for (const k of endpoint) expect(k.source).toBe("endpoint");
    for (const k of resell) expect(k.source).toBe("resell");
  });

  it("a pre-012 row (source NULL) reads as endpoint", async () => {
    const { driver, keys } = await load();
    const db = await driver.getAdapter();

    const key = await keys.createApiKey("legacy-ish", "m1", {});
    // Simulate a row minted before migration 012 existed.
    db.run(`UPDATE apiKeys SET source = NULL WHERE id = ?`, [key.id]);

    const read = await keys.getApiKeyById(key.id);
    expect(read.source).toBe("endpoint");
  });
});
