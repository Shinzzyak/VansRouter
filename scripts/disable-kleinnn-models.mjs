#!/usr/bin/env node
/**
 * disable-kleinnn-models.mjs — hide the models that failed the masking audit
 * on the `kln` node (prefix kln) by writing into kv scope=disabledModels.
 *
 * Same row shape the dashboard's "disable model" toggle writes
 * (src/lib/db/repos/disabledModelsRepo.js: scope "disabledModels", key = providerAlias).
 *
 * Usage: node scripts/disable-kleinnn-models.mjs [dry|list]
 */
import { DatabaseSync } from "node:sqlite";
import { KEEP, DISABLE } from "./kln-models.mjs";

const DB = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const SCOPE = "disabledModels";
const MODE = process.argv[2] || "apply";

const db = new DatabaseSync(DB);

const node = db
  .prepare("SELECT id FROM providerNodes WHERE data LIKE ?")
  .get(`%"prefix":"kln"%`);
if (!node) {
  console.error("kln node not found — run add-kleinnn-node.mjs first");
  process.exit(1);
}

if (MODE === "list") {
  const row = db.prepare("SELECT value FROM kv WHERE scope=? AND key=?").get(SCOPE, "kln");
  console.log("kln disabled:", row ? row.value : "(none)");
  db.close();
  process.exit(0);
}

if (MODE === "dry") {
  console.log(`[dry] would disable on kln (${DISABLE.length}): ${DISABLE.join(", ")}`);
  console.log(`[dry] would keep enabled      (${KEEP.length}): ${KEEP.join(", ")}`);
  db.close();
  process.exit(0);
}

const row = db.prepare("SELECT value FROM kv WHERE scope=? AND key=?").get(SCOPE, "kln");
const current = row ? JSON.parse(row.value) : [];
const merged = [...new Set([...current, ...DISABLE])];
db.prepare(
  "INSERT INTO kv(scope, key, value) VALUES(?,?,?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value"
).run(SCOPE, "kln", JSON.stringify(merged));

console.log(`kln disabled models (${merged.length}): ${merged.join(", ")}`);
console.log(`kept enabled (${KEEP.length}): ${KEEP.join(", ")}`);
db.close();
