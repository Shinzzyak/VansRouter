import { getAdapter } from "../driver.js";

// Per-API-key model allowlist (9router-go F-7 parity).
//
// Policy only: it decides whether a key MAY reach a model. It never influences
// which provider serves that model — routing stays the engine's business.
//
// The invariant that makes this safe: an empty allowlist means "no allowlist
// configured" and allows everything. Every key minted before this table existed
// therefore keeps behaving exactly as it did, and clearing the list restores the
// default rather than locking the buyer out.

/** Bound one key's allowlist — every entry is matched per request. */
export const MAX_ALLOWLIST_ENTRIES = 200;
export const MAX_ALLOWLIST_ENTRY_LENGTH = 256;

/** Trim entries and drop blanks so a pasted newline can't become an unmatchable pattern. */
export function cleanModelPatterns(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (v) out.push(v);
  }
  return out;
}

/** Reject an oversized allowlist with a message naming the limit. */
export function validateModelAllowlist(models) {
  if (models.length > MAX_ALLOWLIST_ENTRIES) {
    return { ok: false, error: `too many model patterns: ${models.length}, maximum is ${MAX_ALLOWLIST_ENTRIES}` };
  }
  for (const m of models) {
    if (m.length > MAX_ALLOWLIST_ENTRY_LENGTH) {
      return { ok: false, error: `model pattern exceeds ${MAX_ALLOWLIST_ENTRY_LENGTH} characters` };
    }
  }
  return { ok: true, models };
}

/** Accepts {"models": [...]} or a bare [...] body. */
export function parseModelAllowlistBody(body) {
  if (body === null || body === undefined) return { ok: true, models: [] };
  const raw = Array.isArray(body) ? body : body?.models;
  if (!Array.isArray(raw)) return { ok: false, error: "models must be a string array" };
  return validateModelAllowlist(cleanModelPatterns(raw));
}

/**
 * Allowlist patterns for one key. Empty array (never null) means "no allowlist"
 * → the caller allows everything.
 */
export async function getAllowedModels(apiKeyId) {
  if (!apiKeyId) return [];
  const db = await getAdapter();
  const rows = db.all(
    `SELECT model FROM apiKeyModelAccess WHERE apiKeyId = ? ORDER BY model`,
    [apiKeyId],
  );
  return (rows || []).map((r) => r.model).filter((m) => typeof m === "string" && m.trim() !== "");
}

/**
 * Allowlist of every id in one query, so listing N keys costs 1 query instead of
 * N. Keys without a row come back with an empty array, keeping the
 * "absent == allow all" rule uniform.
 */
export async function getAllowedModelsForKeys(ids) {
  const out = {};
  const unique = [];
  for (const id of ids || []) {
    if (!id || out[id] !== undefined) continue;
    out[id] = [];
    unique.push(id);
  }
  if (unique.length === 0) return out;

  const db = await getAdapter();
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db.all(
    `SELECT apiKeyId, model FROM apiKeyModelAccess WHERE apiKeyId IN (${placeholders}) ORDER BY apiKeyId, model`,
    unique,
  );
  for (const r of rows || []) {
    if (typeof r.model === "string" && r.model.trim() !== "") out[r.apiKeyId].push(r.model);
  }
  return out;
}

/**
 * Replace a key's allowlist in one transaction: either the whole new list lands
 * or none of it does, so a client can never observe a half-applied policy.
 * An empty list clears the allowlist and restores allow-everything.
 */
export async function setAllowedModels(apiKeyId, models) {
  if (!apiKeyId) throw new Error("set allowed models: empty apiKey id");
  const db = await getAdapter();
  const clean = cleanModelPatterns(models);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.run(`DELETE FROM apiKeyModelAccess WHERE apiKeyId = ?`, [apiKeyId]);
    const seen = new Set();
    for (const m of clean) {
      if (seen.has(m)) continue;
      seen.add(m);
      db.run(
        `INSERT OR REPLACE INTO apiKeyModelAccess (apiKeyId, model, createdAt) VALUES (?, ?, ?)`,
        [apiKeyId, m, now],
      );
    }
  });

  return clean;
}

/**
 * Whether the table exists. A database created before this feature answers
 * false, which keeps a missing table a "no allowlist" case rather than a crash.
 */
export async function hasAllowedModelsTable() {
  try {
    const db = await getAdapter();
    db.get(`SELECT 1 FROM apiKeyModelAccess LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}
