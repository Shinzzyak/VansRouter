#!/usr/bin/env node
/**
 * import-bai-keys.mjs
 * Imports B.AI keys from GATE-X keys-oauth.txt into VansRouter providerConnections
 * (provider "bai"). Format per line: email<TAB>sk-...
 *
 * Usage: node import-bai-keys.mjs [keys-file] [dry]
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DB = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const KEYS_FILE = process.argv[2] || "/home/ubuntu/.gate-x/farm-scripts/b_ai/keys-oauth.txt";
const DRY = process.argv.includes("dry");

if (!existsSync(KEYS_FILE)) {
  console.error("keys file not found:", KEYS_FILE);
  process.exit(1);
}

const db = new DatabaseSync(DB);
const lines = readFileSync(KEYS_FILE, "utf8").split("\n").filter(Boolean);

let added = 0, skipped = 0, failed = 0;
for (const line of lines) {
  const [email, key] = line.split("\t").map(s => (s || "").trim());
  if (!email || !key || !key.startsWith("sk-")) { failed++; continue; }

  // check existing
  const existing = db.prepare("SELECT id FROM providerConnections WHERE provider=? AND email=?").all("bai", email);
  if (existing.length) { skipped++; continue; }

  if (DRY) { console.log(`[dry] would add ${email} -> ${key.slice(0,10)}...`); added++; continue; }

  const data = JSON.stringify({
    apiKey: key,
    testStatus: "active",
    providerSpecificData: { source: "gatex-bai-farm", importedAt: new Date().toISOString() },
    lastUsedAt: null, consecutiveUseCount: 0,
  });
  db.prepare("INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), "bai", "apikey", null, email, 1, 1, data, new Date().toISOString(), new Date().toISOString());
  added++;
}

console.log(`DONE: added=${added} skipped=${skipped} failed=${failed} (${lines.length} lines)`);
if (DRY) console.log("(dry run - no changes written)");
