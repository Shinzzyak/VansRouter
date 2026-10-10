// Apply migration 009 to a COPY of the live DB and exercise the table.
// Proves the DDL is idempotent and the composite PK does its job, without
// touching the running database.
import Database from "better-sqlite3";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import m009 from "../src/lib/db/migrations/009-add-api-key-model-access.js";
import { TABLES } from "../src/lib/db/schema.js";

const SRC = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const DST = "/home/ubuntu/.hermes/profiles/gefreit/cache/scratch/waveC/mig009.sqlite";

if (existsSync(DST)) unlinkSync(DST);
copyFileSync(SRC, DST);

const db = new Database(DST);
db.pragma("journal_mode = WAL");

// Twice on purpose: migrations must be re-runnable.
m009.up(db);
m009.up(db);

const table = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='apiKeyModelAccess'`)
  .get();
console.log("TABLE_EXISTS:", !!table);

const keyId = "probe-key-009";
db.prepare(`DELETE FROM apiKeyModelAccess WHERE apiKeyId = ?`).run(keyId);
db.prepare(`INSERT INTO apiKeyModelAccess (apiKeyId, model, createdAt) VALUES (?,?,?)`).run(keyId, "za/*", "2026-10-10T00:00:00Z");
db.prepare(`INSERT OR REPLACE INTO apiKeyModelAccess (apiKeyId, model, createdAt) VALUES (?,?,?)`).run(keyId, "za/*", "2026-10-10T00:00:01Z");
const rows = db.prepare(`SELECT model FROM apiKeyModelAccess WHERE apiKeyId = ? ORDER BY model`).all(keyId);
console.log("ROWS:", JSON.stringify(rows));

// Composite PK must reject a duplicate (apiKeyId, model).
let pkRejected = false;
try {
  db.prepare(`INSERT INTO apiKeyModelAccess (apiKeyId, model, createdAt) VALUES (?,?,?)`).run(keyId, "za/*", "x");
} catch {
  pkRejected = true;
}
console.log("PK_REJECTS_DUPLICATE:", pkRejected);

// Live DB must be untouched by this probe.
const live = new Database(SRC, { readonly: true });
const liveHas = live
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='apiKeyModelAccess'`)
  .get();
console.log("LIVE_DB_UNTOUCHED:", !liveHas);
live.close();
db.prepare(`DELETE FROM apiKeyModelAccess WHERE apiKeyId = ?`).run(keyId);
db.close();
console.log("SCHEMA_DECLARED:", !!TABLES.apiKeyModelAccess);
