import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { maskApiKey } from "../helpers/apiKeyMask.js";
import { getAllowedModels, setAllowedModels } from "./apiKeyModelAccessRepo.js";

// Parse a JSON TEXT column with null=all / []=none semantics.
// DB NULL → null (all allowed). DB "[]" → [] (none). DB "[x]" → [x].
function parsePermList(raw) {
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Serialize back: null → null (DB NULL), [] → "[]", [x] → "[x]"
function serializePermList(val) {
  if (val === null || val === undefined) return null;
  return JSON.stringify(Array.isArray(val) ? val : []);
}

// Create-time allow-list input, same acceptance rule as PUT: null/undefined
// means "all allowed", an array is taken verbatim, anything else is ignored.
function normalizePerm(val) {
  if (val === null || val === undefined) return null;
  return Array.isArray(val) ? val : null;
}

// Parse optional integer limit: null/undefined stays null, otherwise integer or null on bad input.
function parseLimitInt(raw) {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    allowedProviders: parsePermList(row.allowedProviders),
    allowedCombos: parsePermList(row.allowedCombos),
    allowedKinds: parsePermList(row.allowedKinds),
    expiresAt: row.expiresAt || null,
    maxTokens: parseLimitInt(row.maxTokens),
    maxTokensDaily: parseLimitInt(row.maxTokensDaily),
    rpm: parseLimitInt(row.rpm),
    rph: parseLimitInt(row.rph),
    rpd: parseLimitInt(row.rpd),
    tokens5h: parseLimitInt(row.tokens5h),
    tokensWeekly: parseLimitInt(row.tokensWeekly),
    tokensMonthly: parseLimitInt(row.tokensMonthly),
    // Persona opt-out (2026-09-30). Fail-SAFE toward today's behaviour: only an
    // explicit 0/false exempts a key, so a row read before the column exists
    // (or any unexpected value) still gets the full identity stack.
    personaInject: !(row.personaInject === 0 || row.personaInject === false),
    // Resale governance (9router-go parity). null = unrestricted/unknown, which
    // is exactly what a pre-upgrade row means.
    rateLimitTpm: parseLimitInt(row.rateLimitTpm),
    rateLimitConcurrency: parseLimitInt(row.rateLimitConcurrency),
    keyDisplay: row.keyDisplay || maskApiKey(row.key),
    lastUsedAt: row.lastUsedAt || null,
    usedCount: parseLimitInt(row.usedCount) ?? 0,
    metadata: row.metadata || null,
    // Resale hardening (migration 010). NULL keeps today's behaviour: the key is
    // reachable from any source address and carries no prepaid balance gate.
    allowedIps: parsePermList(row.allowedIps),
    tokenBalance: parseLimitInt(row.tokenBalance),
    tokensSpent: parseLimitInt(row.tokensSpent) ?? 0,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, limits = {}) {
  if (!machineId) throw new Error("machineId is required");
  const [db, { generateApiKeyWithMachine }] = await Promise.all([
    getAdapter(),
    import("@/shared/utils/apiKey"),
  ]);
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: randomUUID(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    allowedProviders: normalizePerm(limits.allowedProviders),
    allowedCombos: normalizePerm(limits.allowedCombos),
    allowedKinds: normalizePerm(limits.allowedKinds),
    expiresAt: limits.expiresAt || null,
    maxTokens: parseLimitInt(limits.maxTokens),
    maxTokensDaily: parseLimitInt(limits.maxTokensDaily),
    rpm: parseLimitInt(limits.rpm),
    rph: parseLimitInt(limits.rph),
    rpd: parseLimitInt(limits.rpd),
    tokens5h: parseLimitInt(limits.tokens5h),
    tokensWeekly: parseLimitInt(limits.tokensWeekly),
    tokensMonthly: parseLimitInt(limits.tokensMonthly),
    personaInject: limits.personaInject === false ? false : true,
    rateLimitTpm: parseLimitInt(limits.rateLimitTpm),
    rateLimitConcurrency: parseLimitInt(limits.rateLimitConcurrency),
    keyDisplay: maskApiKey(result.key),
    lastUsedAt: null,
    usedCount: 0,
    metadata: limits.metadata ?? null,
    allowedIps: normalizePerm(limits.allowedIps),
    tokenBalance: parseLimitInt(limits.tokenBalance),
    tokensSpent: parseLimitInt(limits.tokensSpent) ?? 0,
  };
  db.run(
    `INSERT INTO apiKeys(
      id, key, name, machineId, isActive, createdAt,
      allowedProviders, allowedCombos, allowedKinds,
      expiresAt, maxTokens, maxTokensDaily, rpm, rph, rpd, tokens5h, tokensWeekly, tokensMonthly, personaInject,
      rateLimitTpm, rateLimitConcurrency, keyDisplay, lastUsedAt, usedCount, metadata,
      allowedIps, tokenBalance, tokensSpent
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      serializePermList(apiKey.allowedProviders),
      serializePermList(apiKey.allowedCombos),
      serializePermList(apiKey.allowedKinds),
      apiKey.expiresAt, apiKey.maxTokens, apiKey.maxTokensDaily, apiKey.rpm, apiKey.rph, apiKey.rpd,
      apiKey.tokens5h, apiKey.tokensWeekly, apiKey.tokensMonthly,
      apiKey.personaInject ? 1 : 0,
      apiKey.rateLimitTpm, apiKey.rateLimitConcurrency, apiKey.keyDisplay, null, 0, apiKey.metadata,
      serializePermList(apiKey.allowedIps), apiKey.tokenBalance, apiKey.tokensSpent,
    ]
  );
  // The per-model allow-list lives in its own table (empty = allow all), so it
  // is written after the row exists. A caller that passes one gets the same
  // policy it would have had to PUT a second time to apply.
  apiKey.allowedModels = Array.isArray(limits.allowedModels) && limits.allowedModels.length > 0
    ? await setAllowedModels(apiKey.id, limits.allowedModels)
    : [];
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    // Merge: only override fields explicitly present in data
    const merged = { ...current };
    if (data.isActive !== undefined) merged.isActive = data.isActive;
    if (data.name !== undefined) merged.name = data.name;
    if ("allowedProviders" in data) merged.allowedProviders = data.allowedProviders;
    if ("allowedCombos" in data) merged.allowedCombos = data.allowedCombos;
    if ("allowedKinds" in data) merged.allowedKinds = data.allowedKinds;
    if ("expiresAt" in data) merged.expiresAt = data.expiresAt || null;
    if ("maxTokens" in data) merged.maxTokens = parseLimitInt(data.maxTokens);
    if ("maxTokensDaily" in data) merged.maxTokensDaily = parseLimitInt(data.maxTokensDaily);
    if ("rpm" in data) merged.rpm = parseLimitInt(data.rpm);
    if ("rph" in data) merged.rph = parseLimitInt(data.rph);
    if ("rpd" in data) merged.rpd = parseLimitInt(data.rpd);
    if ("tokens5h" in data) merged.tokens5h = parseLimitInt(data.tokens5h);
    if ("tokensWeekly" in data) merged.tokensWeekly = parseLimitInt(data.tokensWeekly);
    if ("tokensMonthly" in data) merged.tokensMonthly = parseLimitInt(data.tokensMonthly);
    // Explicit false/0 opts the key out; anything else keeps today's behaviour.
    if ("personaInject" in data) merged.personaInject = !(data.personaInject === false || data.personaInject === 0);
    // Resale governance (9router-go parity).
    if ("rateLimitTpm" in data) merged.rateLimitTpm = parseLimitInt(data.rateLimitTpm);
    if ("rateLimitConcurrency" in data) merged.rateLimitConcurrency = parseLimitInt(data.rateLimitConcurrency);
    if ("metadata" in data) merged.metadata = data.metadata === null || data.metadata === undefined ? null : String(data.metadata);
    // Resale hardening (migration 010).
    if ("allowedIps" in data) merged.allowedIps = normalizePerm(data.allowedIps);
    if ("tokenBalance" in data) merged.tokenBalance = parseLimitInt(data.tokenBalance);
    if ("tokensSpent" in data) merged.tokensSpent = parseLimitInt(data.tokensSpent) ?? 0;
    if ("key" in data && data.key) {
      merged.key = data.key;
      merged.keyDisplay = maskApiKey(data.key);
    }

    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?,
        allowedProviders = ?, allowedCombos = ?, allowedKinds = ?,
        expiresAt = ?, maxTokens = ?, maxTokensDaily = ?, rpm = ?, rph = ?, rpd = ?,
        tokens5h = ?, tokensWeekly = ?, tokensMonthly = ?, personaInject = ?,
        rateLimitTpm = ?, rateLimitConcurrency = ?, keyDisplay = ?, metadata = ?,
        allowedIps = ?, tokenBalance = ?, tokensSpent = ?
      WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        serializePermList(merged.allowedProviders),
        serializePermList(merged.allowedCombos),
        serializePermList(merged.allowedKinds),
        merged.expiresAt,
        merged.maxTokens,
        merged.maxTokensDaily,
        merged.rpm,
        merged.rph,
        merged.rpd,
        merged.tokens5h,
        merged.tokensWeekly,
        merged.tokensMonthly,
        merged.personaInject ? 1 : 0,
        merged.rateLimitTpm,
        merged.rateLimitConcurrency,
        merged.keyDisplay,
        merged.metadata,
        serializePermList(merged.allowedIps),
        merged.tokenBalance,
        merged.tokensSpent ?? 0,
        id,
      ]
    );
    result = merged;
  });
  return result;
}

// Mint a replacement secret in place. The row keeps its id, policy, allowlists
// and usage history, so a leaked key can be rotated without deleting the record
// (and without re-teaching the buyer a new key id). Returns null if unknown.
export async function rotateApiKey(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(row.machineId);
  const keyDisplay = maskApiKey(result.key);
  db.run(`UPDATE apiKeys SET key = ?, keyDisplay = ? WHERE id = ?`, [result.key, keyDisplay, id]);
  return { id, key: result.key, keyDisplay };
}

// Flip isActive without touching any other field (Go's PUT /keys/{id}/toggle).
export async function toggleApiKey(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;
  const next = row.isActive === 1 || row.isActive === true ? 0 : 1;
  db.run(`UPDATE apiKeys SET isActive = ? WHERE id = ?`, [next, id]);
  return { id, isActive: next === 1 };
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

// Raw lookup used for DIAGNOSIS only: it returns the row even when the key is
// disabled or expired, so the caller can say WHY a key was refused instead of
// the useless "Invalid API key". Never use this for authorization.
export async function getApiKeyByValueAny(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return row ? rowToKey(row) : null;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  if (!row || (row.isActive !== 1 && row.isActive !== true)) return null;
  const apiKey = rowToKey(row);
  if (apiKey.expiresAt) {
    const expiry = new Date(apiKey.expiresAt).getTime();
    if (expiry && expiry <= Date.now()) return null;
  }
  // Telemetry for "is this sold key still alive": bump lastUsedAt/usedCount.
  // Throttled to one write a minute per key — auth runs on every request and a
  // write per request would hammer the WAL for no extra information.
  // ponytail: minute-granularity counter, move to the usage tables if a
  // per-request audit trail is ever needed.
  const last = apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).getTime() : 0;
  if (!last || Date.now() - last > 60_000) {
    try {
      db.run(`UPDATE apiKeys SET lastUsedAt = ?, usedCount = COALESCE(usedCount, 0) + 1 WHERE id = ?`, [
        new Date().toISOString(),
        apiKey.id,
      ]);
    } catch {
      // Telemetry must never fail auth.
    }
  }
  // Per-key model allowlist (F-7). A read failure degrades to "no allowlist"
  // rather than denying traffic the key has always been allowed to send.
  try {
    apiKey.allowedModels = await getAllowedModels(apiKey.id);
  } catch {
    apiKey.allowedModels = [];
  }
  return apiKey;
}

// Prepaid balance accounting (migration 010). Only keys that carry a non-null
// tokenBalance are ever written to — every other key keeps the zero-write
// dispatch path it had before this column existed.
//
// ponytail: one UPDATE per completed request, gated on tokenBalance IS NOT NULL.
// Batch it into the usage tables if a seller ever runs thousands of balanced
// keys and the WAL becomes the bottleneck.
export async function addApiKeyTokensSpent(id, tokens) {
  const amount = Math.floor(Number(tokens) || 0);
  if (!id || amount <= 0) return false;
  const db = await getAdapter();
  db.run(
    `UPDATE apiKeys SET tokensSpent = COALESCE(tokensSpent, 0) + ? WHERE id = ? AND tokenBalance IS NOT NULL`,
    [amount, id]
  );
  return true;
}

// Set a key's prepaid balance outright (admin top-up / correction). null clears
// the gate entirely and returns the key to unlimited behaviour.
export async function setApiKeyBalance(id, tokens) {
  const db = await getAdapter();
  const row = db.get(`SELECT id FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;
  const next = tokens === null || tokens === undefined ? null : parseLimitInt(tokens);
  db.run(`UPDATE apiKeys SET tokenBalance = ? WHERE id = ?`, [next, id]);
  return { id, tokenBalance: next };
}
