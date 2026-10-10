#!/usr/bin/env node
/**
 * add-kleinnn-node.mjs — register the kleinnn endpoint as a custom provider node.
 *
 * Creates (idempotent, no duplicate):
 *   providerNodes       : prefix `kln`, type openai-compatible, baseUrl apill.kleinnn.my.id/v1
 *   providerConnections : one apikey connection under that node
 *
 * Usage: node scripts/add-kleinnn-node.mjs [dry]
 *   dry -> prints what would be written, touches nothing.
 *
 * Same write path as scripts/import-bai-keys.mjs (node:sqlite against data/db/data.sqlite),
 * which is already run by a 10m cron while the router is up — a direct row insert is safe.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const DB = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const DRY = process.argv.includes("dry");

const NODE = {
  prefix: "kln",
  name: "Kleinnn",
  baseUrl: "https://apill.kleinnn.my.id/v1",
  apiType: "chat",
};
const CONN = {
  apiKey: process.env.KLEINNN_API_KEY,
  name: "kln-bonus-1h", // paket "Bonus 1 hari", aktif s/d 2026-09-30 10:03 WIB
};

const db = new DatabaseSync(DB);

const existingNode = db
  .prepare("SELECT id FROM providerNodes WHERE data LIKE ?")
  .get(`%"prefix":"${NODE.prefix}"%`);

if (existingNode) {
  console.log(`node already present: ${existingNode.id}`);
} else if (DRY) {
  console.log(`[dry] would create node prefix=${NODE.prefix} baseUrl=${NODE.baseUrl}`);
} else {
  const now = new Date().toISOString();
  const id = `openai-compatible-chat-${randomUUID()}`;
  db.prepare(
    "INSERT INTO providerNodes (id, type, name, data, createdAt, updatedAt) VALUES (?,?,?,?,?,?)"
  ).run(
    id,
    "openai-compatible",
    NODE.name,
    JSON.stringify({ prefix: NODE.prefix, apiType: NODE.apiType, baseUrl: NODE.baseUrl }),
    now,
    now
  );
  console.log(`node created: ${id}`);
}

const nodeRow = DRY && !existingNode
  ? null
  : existingNode ||
    db.prepare("SELECT id FROM providerNodes WHERE data LIKE ?").get(`%"prefix":"${NODE.prefix}"%`);
const nodeId = nodeRow?.id;

if (!nodeId) {
  console.log("(dry run — node not written yet, connection step skipped)");
  db.close();
  process.exit(0);
}

const existingConn = db
  .prepare("SELECT id FROM providerConnections WHERE provider = ?")
  .get(nodeId);

if (existingConn) {
  console.log(`connection already present: ${existingConn.id}`);
} else if (DRY) {
  console.log(`[dry] would create connection ${CONN.name} under ${nodeId}`);
} else {
  const now = new Date().toISOString();
  const id = randomUUID();
  const data = JSON.stringify({
    apiKey: CONN.apiKey,
    testStatus: "active",
    providerSpecificData: {
      prefix: NODE.prefix,
      apiType: NODE.apiType,
      baseUrl: NODE.baseUrl,
      nodeName: NODE.name,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
    },
    errorCode: null,
    backoffLevel: 0,
  });
  db.prepare(
    "INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, nodeId, "apikey", CONN.name, null, 1, 1, data, now, now);
  console.log(`connection created: ${id}`);
}

const nodes = db.prepare("SELECT COUNT(*) AS n FROM providerNodes").get().n;
const conns = db.prepare("SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?").get(nodeId).n;
console.log(`DONE: providerNodes=${nodes}  kln-connections=${conns}${DRY ? " (dry run)" : ""}`);
db.close();
