#!/usr/bin/env node
/**
 * add-kleinnn-models.mjs — populate the kln node's model catalog.
 *
 * Custom OpenAI-compatible nodes (uuid-suffixed) skip the live /models fetch
 * (allowedModels.js: UPSTREAM_CONNECTION_RE test), so their catalog comes from
 * kv scope=customModels — exactly the rows the dashboard writes when you add a
 * model by hand. Without these rows the node shows zero models in the picker.
 *
 * Only the 6 verified-honest ids are written (see kln-models.mjs). The 8 masked
 * ones are simply never added, and are also blocked in disabledModels.
 *
 * Usage: node scripts/add-kleinnn-models.mjs [dry]
 */
import { DatabaseSync } from "node:sqlite";
import { KLN, KEEP } from "./kln-models.mjs";

const DB = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const SCOPE = "customModels";
const DRY = process.argv.includes("dry");

const db = new DatabaseSync(DB);
const node = db.prepare("SELECT id FROM providerNodes WHERE data LIKE ?").get(`%"prefix":"${KLN.prefix}"%`);
if (!node) {
  console.error("kln node missing — run add-kleinnn-node.mjs first");
  process.exit(1);
}

let added = 0, skipped = 0, pruned = 0;
for (const id of KEEP) {
  const key = `${node.id}|${id}|llm`;
  const exists = db.prepare("SELECT 1 FROM kv WHERE scope=? AND key=?").get(SCOPE, key);
  if (exists) { skipped++; continue; }
  if (DRY) { console.log(`[dry] would add ${KLN.prefix}/${id}`); added++; continue; }
  db.prepare("INSERT INTO kv(scope, key, value) VALUES(?,?,?)").run(
    SCOPE,
    key,
    JSON.stringify({ providerAlias: node.id, id, type: "llm", name: id })
  );
  added++;
}

// Prune customModels rows for this node whose id is no longer in KEEP
// (e.g. the mimo family, dropped after the session-2 classifier revision).
const stale = db.prepare("SELECT key FROM kv WHERE scope=? AND key LIKE ?").all(SCOPE, `${node.id}|%`)
  .map((r) => r.key)
  .filter((k) => !KEEP.includes(k.split("|")[1]));
for (const k of stale) {
  if (DRY) { console.log(`[dry] would prune ${k.split("|")[1]}`); pruned++; continue; }
  db.prepare("DELETE FROM kv WHERE scope=? AND key=?").run(SCOPE, k);
  pruned++;
}

console.log(`DONE: added=${added} skipped=${skipped} pruned=${pruned} keep=${KEEP.length}${DRY ? " (dry)" : ""}`);
console.log(`node=${node.id}`);
db.close();
