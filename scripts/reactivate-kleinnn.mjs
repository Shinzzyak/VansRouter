#!/usr/bin/env node
/**
 * reactivate-kleinnn.mjs — bring the kln connection back after the router's
 * auto-disable on an upstream 400 `insufficient_balance`.
 *
 * When the relay answers 400 "credit insufficient balance: balance=X required=Y",
 * the account-fallback layer marks the connection inactive (isActive=0) and stamps
 * errorCode / lastErrorType / balanceExhaustedAt. isActive=0 makes the node invisible
 * in /v1/models AND makes the chat path answer 404 ("Model ... is not available"),
 * so it looks like the provider vanished when it is only quota-gated.
 *
 * Usage: node scripts/reactivate-kleinnn.mjs [dry|show]
 */
import { DatabaseSync } from "node:sqlite";
import { KLN } from "./kln-models.mjs";

const DB = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const MODE = process.argv[2] || "apply";

const db = new DatabaseSync(DB);
const node = db.prepare("SELECT id FROM providerNodes WHERE data LIKE ?").get(`%"prefix":"${KLN.prefix}"%`);
if (!node) { console.error("kln node missing"); process.exit(1); }

const conns = db.prepare("SELECT id, isActive, data FROM providerConnections WHERE provider=?").all(node.id);
if (!conns.length) { console.error("kln connection missing"); process.exit(1); }

for (const c of conns) {
  const d = JSON.parse(c.data);
  if (MODE === "show") {
    console.log(`${c.id} isActive=${c.isActive} testStatus=${d.testStatus} errorCode=${d.errorCode} ` +
                `lastErrorType=${d.lastErrorType} balanceExhaustedAt=${d.balanceExhaustedAt} ` +
                `lastError=${String(d.lastError).slice(0, 90)}`);
    continue;
  }
  if (MODE === "dry") {
    console.log(`[dry] would set isActive=1 and clear the balance error stamps on ${c.id}`);
    continue;
  }
  delete d.errorCode;
  delete d.lastErrorType;
  delete d.lastError;
  delete d.lastErrorAt;
  delete d.balanceExhaustedAt;
  d.testStatus = "active";
  for (const k of Object.keys(d)) if (k.startsWith("modelLock_")) delete d[k];

  db.prepare("UPDATE providerConnections SET isActive=1, data=?, updatedAt=? WHERE id=?")
    .run(JSON.stringify(d), new Date().toISOString(), c.id);
  console.log(`${c.id}: isActive=1, balance error stamps cleared`);
}
db.close();
