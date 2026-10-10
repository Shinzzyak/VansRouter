import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { sealConnectionData, unsealConnectionData } from "@/lib/vault/index.js";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

export function rowToConn(row) {
  if (!row) return null;
  // Sealed fields come back plaintext for every caller; a field this process
  // cannot unwrap is dropped (and named in `unreadable`) so it can never be
  // forwarded upstream as if it were a real credential.
  const { data: extra } = unsealConnectionData(parseJson(row.data, {}));
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(sealConnectionData(rest)),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Pool ordering contract, shared by every reorder path (9router-go parity):
// a NULL priority sorts LAST (never first), ties break by updatedAt DESC then
// id ASC so the order is total and stable across processes.
function poolOrderInTx(db, providerId) {
  return db.all(
    `SELECT id FROM providerConnections WHERE provider = ?
     ORDER BY CASE WHEN priority IS NULL THEN 999999 ELSE priority END ASC,
              updatedAt DESC, id ASC`,
    [providerId],
  ).map((r) => r.id);
}

// Renumber a pool to a contiguous 1..N in the given row order. Inside a tx.
function renumberInTx(db, order) {
  const now = new Date().toISOString();
  order.forEach((rowId, i) => {
    db.run(`UPDATE providerConnections SET priority = ?, updatedAt = ? WHERE id = ?`, [i + 1, now, rowId]);
  });
}

// Internal sync renumber — must be called INSIDE a transaction.
function reorderInTx(db, providerId) {
  renumberInTx(db, poolOrderInTx(db, providerId));
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    const all = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);

    let existing = null;
    // Dedup precedence: cursor oauth rows key on machineId (stable even when
    // profile-email extraction fails); other oauth rows key on email;
    // apikey rows key on name.
    // access_token: never dedup — user manages duplicates manually
    if (data.provider === "cursor" && data.authType === "oauth" && data.providerSpecificData?.machineId) {
      existing = all.find(c => c.provider === "cursor" && c.providerSpecificData?.machineId === data.providerSpecificData.machineId);
    } else if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }

    if (existing) {
      const merged = { ...existing, ...data, updatedAt: now };
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${all.length + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
    }

    const conn = {
      id: randomUUID(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    reorderInTx(db, data.provider);
    result = conn;
  });

  return result;
}

export async function createProviderConnectionsBulk(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    throw new Error("Bulk connection batch must contain 1-500 items");
  }
  const db = await getAdapter();
  const results = [];
  db.transaction(() => {
    for (const data of items) {
      if (!data?.provider || !data?.apiKey || !data?.name) {
        results.push({ name: data?.name || null, ok: false, error: "provider, apiKey, and name are required" });
        continue;
      }
      const existing = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider])
        .map(rowToConn)
        .find((connection) => connection.authType === "apikey" && connection.name === data.name);
      const now = new Date().toISOString();
      const connection = existing
        ? {
            ...existing,
            ...data,
            providerSpecificData: data.providerSpecificData === undefined
              ? existing.providerSpecificData
              : data.providerSpecificData,
            authType: "apikey",
            updatedAt: now,
          }
        : {
            id: randomUUID(), provider: data.provider, authType: "apikey", name: data.name,
            priority: data.priority || 1, isActive: true, createdAt: now, updatedAt: now,
            apiKey: data.apiKey, testStatus: data.testStatus || "unknown",
            providerSpecificData: data.providerSpecificData,
          };
      upsert(db, connection);
      results.push({ name: data.name, ok: true, id: connection.id, updated: !!existing });
    }
    for (const provider of new Set(items.map((item) => item.provider))) reorderInTx(db, provider);
  });
  return results;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return before?.n || 0;
}

// Reorder a provider's pool. Called INSIDE nothing — opens its own transaction.
//
// `id` + `direction` (−1 up / +1 down) moves one row one slot; the swap AND the
// 1..N renumber happen in the SAME transaction, so a partial failure can never
// leave two rows sharing a priority (a tie a stable sort then freezes into a
// permanent no-op — the bug the two-PUT client swap used to cause).
//
// `id` alone (or neither) renumbers the pool in place, repairing gaps left by
// deletes and normalising duplicate priorities from older data.
//
// Returns { order } on success, { error: "not_found" } when `id` is not in the
// pool. Callers map that to 404.
export async function reorderProviderConnections(providerId, id = null, direction = 0) {
  const db = await getAdapter();
  let out;
  db.transaction(() => {
    const order = poolOrderInTx(db, providerId);
    if (id) {
      const idx = order.indexOf(id);
      if (idx < 0) { out = { error: "not_found" }; return; }
      const target = idx + direction;
      if (target >= 0 && target < order.length) {
        [order[idx], order[target]] = [order[target], order[idx]];
      }
    }
    renumberInTx(db, order);
    out = { order };
  });
  return out;
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
