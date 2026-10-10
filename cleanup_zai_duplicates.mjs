#!/usr/bin/env node
/**
 * Remove the SHADOWED ZAI duplicate identities from the router DB.
 *
 * Three rows exist for one sidecar (127.0.0.1:8879):
 *
 *   1. registry provider `zai` (alias `za`, priority 142) + connection 37a0a421
 *      -> THE LIVE ONE. `[AUTH] zai | total connections: 1` and the usage line
 *         `account=37a0a421...` prove every zai/* request is served by it.
 *
 *   2. custom node `openai-compatible-chat-afba9301` "ZAI GLM (UI-drive)"
 *      prefix `zai` + connection c2eb096b
 *      -> DEAD BY CONSTRUCTION. `parseModel()` consults
 *         RESERVED_PROVIDER_PREFIXES (built from every registry id + alias)
 *         BEFORE it tries to match a node prefix, and `zai` is in that set.
 *         So `zai/x` always resolves to the registry provider and the node is
 *         never consulted. Same shape as the documented `bai` incident.
 *         Contributes 0 models to /v1/models (node cached rows: 0).
 *
 *   3. connection with provider id `zai-sidecar`
 *      -> ORPHAN. No registry entry, no node, not referenced in source,
 *         combos, apiKeys, or settings.
 *
 * Keeps (1). Removes (2) and (3) plus the 7 orphan kv customModels rows keyed
 * by the node id. Reversible from the JSON + sqlite backup taken beforehand.
 *
 * Usage: node cleanup_zai_duplicates.mjs [--dry-run]
 */
import Database from "better-sqlite3";

const DB = "/home/ubuntu/VansRouter/data/db/data.sqlite";
const NODE_ID = "openai-compatible-chat-afba9301-0e26-4234-8b9f-888231d50985";
const ORPHAN_CONN = "0e02ea87-8276-464c-9423-a47c84d7de97"; // provider = 'zai-sidecar'
const dryRun = process.argv.includes("--dry-run");

const db = new Database(DB);

const before = {
  nodes: db.prepare("SELECT COUNT(*) n FROM providerNodes").get().n,
  conns: db.prepare("SELECT COUNT(*) n FROM providerConnections").get().n,
  kv: db.prepare("SELECT COUNT(*) n FROM kv WHERE scope='customModels'").get().n,
};

const plan = {
  node: db.prepare("SELECT id,name FROM providerNodes WHERE id=?").all(NODE_ID),
  nodeConn: db.prepare("SELECT id,provider FROM providerConnections WHERE provider=?").all(NODE_ID),
  orphanConn: db.prepare("SELECT id,provider FROM providerConnections WHERE provider='zai-sidecar'").all(),
  kvRows: db.prepare("SELECT COUNT(*) n FROM kv WHERE scope='customModels' AND key LIKE ?").get(NODE_ID + "%").n,
};

console.log("BEFORE:", JSON.stringify(before));
console.log("PLAN:", JSON.stringify(plan, null, 1));

if (dryRun) {
  console.log("dry-run: nothing changed");
  process.exit(0);
}

const run = db.transaction(() => {
  const kv = db.prepare("DELETE FROM kv WHERE scope='customModels' AND key LIKE ?").run(NODE_ID + "%");
  const nc = db.prepare("DELETE FROM providerConnections WHERE provider=?").run(NODE_ID);
  const oc = db.prepare("DELETE FROM providerConnections WHERE provider='zai-sidecar'").run();
  const nn = db.prepare("DELETE FROM providerNodes WHERE id=?").run(NODE_ID);
  return { kv: kv.changes, nodeConns: nc.changes, orphanConns: oc.changes, nodes: nn.changes };
});
const changes = run();
console.log("CHANGES:", JSON.stringify(changes));

const after = {
  nodes: db.prepare("SELECT COUNT(*) n FROM providerNodes").get().n,
  conns: db.prepare("SELECT COUNT(*) n FROM providerConnections").get().n,
  kv: db.prepare("SELECT COUNT(*) n FROM kv WHERE scope='customModels'").get().n,
};
console.log("AFTER:", JSON.stringify(after));
console.log("KEPT registry zai connection:",
  JSON.stringify(db.prepare("SELECT id,provider,isActive FROM providerConnections WHERE provider='zai'").all()));
console.log("KEPT zai cached models:",
  db.prepare("SELECT COUNT(*) n FROM cachedProviderModels WHERE providerId='zai'").get().n);
db.close();
