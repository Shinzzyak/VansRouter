// Guardrail policy storage. One row per scope; the resolver picks the narrowest
// enabled row walking apikey → model → provider → global.
import { getAdapter } from "../driver.js";

// A global policy has no id: resolveEngine looks it up as ("global", ""), so a row
// stored with any other id would be invisible to the resolver while still
// appearing in the dashboard. Normalise here, at the single write funnel, rather
// than trusting every caller to send the id it means.
function normalizeScope(scope, scopeId) {
  return { scope, scopeId: scope === "global" ? "" : String(scopeId || "").trim() };
}

function rowToPolicy(row) {
  if (!row) return null;
  let detectors = [];
  try {
    const parsed = JSON.parse(row.detectors || "[]");
    if (Array.isArray(parsed)) detectors = parsed.filter((d) => typeof d === "string");
  } catch {
    // A malformed row is treated as an empty detector list, which disables the
    // policy rather than guessing a set. The row stays visible in the dashboard.
    detectors = [];
  }
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scopeId || "",
    enabled: row.enabled !== 0,
    detectors,
    action: row.action || "log_only",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listGuardrailPolicies(scope = null) {
  const db = await getAdapter();
  if (scope) {
    return db.all("SELECT * FROM guardrailPolicies WHERE scope = ? ORDER BY scopeId", [scope]).map(rowToPolicy);
  }
  return db.all("SELECT * FROM guardrailPolicies ORDER BY scope, scopeId").map(rowToPolicy);
}

export async function getGuardrailPolicy(scope, scopeId) {
  const db = await getAdapter();
  return rowToPolicy(db.get("SELECT * FROM guardrailPolicies WHERE scope = ? AND scopeId = ?", [scope, scopeId || ""]));
}

export async function getGuardrailPolicyById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToPolicy(db.get("SELECT * FROM guardrailPolicies WHERE id = ?", [id]));
}

export async function upsertGuardrailPolicy({ scope, scopeId = "", enabled = 1, detectors = [], action = "log_only" }) {
  if (!scope) return null;
  ({ scope, scopeId } = normalizeScope(scope, scopeId));
  const db = await getAdapter();
  const now = new Date().toISOString();
  const existing = await getGuardrailPolicy(scope, scopeId);
  const payload = [enabled ? 1 : 0, JSON.stringify(detectors || []), action];
  if (existing) {
    db.run("UPDATE guardrailPolicies SET enabled = ?, detectors = ?, action = ?, updatedAt = ? WHERE scope = ? AND scopeId = ?", [
      ...payload, now, scope, scopeId || "",
    ]);
  } else {
    db.run("INSERT INTO guardrailPolicies(id, scope, scopeId, enabled, detectors, action, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)", [
      `gp_${scope}_${scopeId || "global"}_${Date.now().toString(36)}`, scope, scopeId || "", ...payload, now, now,
    ]);
  }
  return getGuardrailPolicy(scope, scopeId);
}

/** Updates a policy addressed by its row id. Returns null when the id is unknown. */
export async function updateGuardrailPolicyById(id, { scope, scopeId, enabled, detectors, action }) {
  const existing = await getGuardrailPolicyById(id);
  if (!existing) return null;
  const nextScope = scope || existing.scope;
  const nextScopeId = normalizeScope(nextScope, scopeId === undefined ? existing.scopeId : scopeId).scopeId;
  // Moving a row onto an occupied (scope, scopeId) would violate the unique
  // index; the caller gets a null rather than a raw SQLite error.
  const occupant = await getGuardrailPolicy(nextScope, nextScopeId);
  if (occupant && occupant.id !== id) return { conflict: occupant };
  const db = await getAdapter();
  db.run("UPDATE guardrailPolicies SET scope = ?, scopeId = ?, enabled = ?, detectors = ?, action = ?, updatedAt = ? WHERE id = ?", [
    nextScope,
    nextScopeId || "",
    (enabled === undefined ? existing.enabled : enabled) ? 1 : 0,
    JSON.stringify(detectors === undefined ? existing.detectors : detectors || []),
    action || existing.action,
    new Date().toISOString(),
    id,
  ]);
  return getGuardrailPolicyById(id);
}

export async function deleteGuardrailPolicy(scope, scopeId = "") {
  const db = await getAdapter();
  db.run("DELETE FROM guardrailPolicies WHERE scope = ? AND scopeId = ?", [scope, scopeId || ""]);
  return true;
}

export async function deleteGuardrailPolicyById(id) {
  if (!id) return false;
  const db = await getAdapter();
  const existing = db.get("SELECT id FROM guardrailPolicies WHERE id = ?", [id]);
  if (!existing) return false;
  db.run("DELETE FROM guardrailPolicies WHERE id = ?", [id]);
  return true;
}
