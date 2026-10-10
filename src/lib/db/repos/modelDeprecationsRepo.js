import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { deprecationKey } from "@/lib/modelDeprecations.js";

// kv rather than a table: the set is small, entirely machine-written, and read
// as a whole map on every dashboard load — the same shape as the
// modelAliases/customModels scopes next to it.
const SCOPE = "modelDeprecations";

export async function listModelDeprecations(provider = "") {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? ORDER BY key`, [SCOPE]);
  const out = {};
  for (const row of rows) {
    const dep = parseJson(row.value, null);
    if (!dep || !dep.provider || !dep.model) continue;
    if (provider && dep.provider !== provider) continue;
    out[row.key] = dep;
  }
  return out;
}

export async function getModelDeprecation(provider, model) {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, deprecationKey(provider, model)]);
  return row ? parseJson(row.value, null) : null;
}

// Upsert: a second 410 with a better message replaces the first.
export async function recordModelDeprecation(dep) {
  if (!dep?.provider || !dep?.model || !dep?.status) return false;
  const db = await getAdapter();
  const key = deprecationKey(dep.provider, dep.model);
  const record = { ...dep, detectedAt: dep.detectedAt || new Date().toISOString() };
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, key, stringifyJson(record)]
  );
  return true;
}

export async function deleteModelDeprecation(provider, model) {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, deprecationKey(provider, model)]);
}
