#!/usr/bin/env node
/**
 * restrict-kleinnn-models.mjs — pin the kln connection's catalog to the verified list.
 *
 * The disabledModels kv entry only hides ids from the picker; the chat path still
 * routes anything the caller names. `providerSpecificData.enabledModels` IS the
 * server-side catalog gate (allowedModels.js: hasExplicitEnabledModels short-circuits
 * the upstream /models fetch and becomes rawModelIds).
 *
 * Usage: node scripts/restrict-kleinnn-models.mjs [dry|show]
 */
import { DatabaseSync } from "node:sqlite";
import { KLN, KEEP } from "./kln-models.mjs";

const DB = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const MODE = process.argv[2] || "apply";

const db = new DatabaseSync(DB);
const node = db.prepare("SELECT id FROM providerNodes WHERE data LIKE ?").get(`%"prefix":"${KLN.prefix}"%`);
if (!node) { console.error("kln node missing"); process.exit(1); }

const conns = db.prepare("SELECT id, data FROM providerConnections WHERE provider=?").all(node.id);
if (conns.length === 0) { console.error("kln connection missing"); process.exit(1); }

for (const c of conns) {
  const d = JSON.parse(c.data);
  if (MODE === "show") {
    console.log(`${c.id}: enabledModels =`, JSON.stringify(d?.providerSpecificData?.enabledModels ?? null));
    continue;
  }
  if (MODE === "dry") {
    console.log(`[dry] ${c.id} enabledModels -> ${JSON.stringify(KEEP)}`);
    continue;
  }
  d.providerSpecificData = { ...(d.providerSpecificData || {}), enabledModels: KEEP };
  db.prepare("UPDATE providerConnections SET data=?, updatedAt=? WHERE id=?")
    .run(JSON.stringify(d), new Date().toISOString(), c.id);
  console.log(`${c.id}: enabledModels pinned to ${KEEP.length} ids`);
}

if (MODE === "apply") {
  console.log(`catalog: ${KEEP.map((m) => `${KLN.prefix}/${m}`).join(", ")}`);
}
db.close();
