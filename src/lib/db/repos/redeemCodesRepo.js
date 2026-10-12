import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";

// Redeem codes: the top-up instrument for a sold key.
//
// A seller mints a batch, hands the codes out (bundled with a key, sold on a
// marketplace, whatever), and the buyer redeems one against the key they hold —
// which credits the key's prepaid token balance and/or pushes its expiry out.
// Everything here is admin-side except `redeemCode`, which is what the buyer's
// own key is allowed to call.

// No 0/O/1/I: codes get read off a screen, pasted from a marketplace listing,
// or typed by hand, and those four are where transcription goes wrong.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomGroup(size) {
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function generateCode() {
  return [randomGroup(4), randomGroup(4), randomGroup(4)].join("-");
}

function parseIntOrNull(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function rowToCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    batchName: row.batchName || null,
    tokenValue: parseIntOrNull(row.tokenValue),
    extendsDays: parseIntOrNull(row.extendsDays),
    maxUses: parseIntOrNull(row.maxUses) ?? 1,
    usedCount: parseIntOrNull(row.usedCount) ?? 0,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt || null,
    metadata: row.metadata || null,
  };
}

/**
 * Mint a batch of codes. quantity is clamped to 1..500 so one request cannot
 * mint an unbounded pile of rows.
 * @returns {Promise<object[]>} the created rows (with their plaintext codes)
 */
export async function createRedeemCodes({
  quantity = 1,
  batchName = null,
  tokenValue = null,
  extendsDays = null,
  maxUses = 1,
  expiresAt = null,
  metadata = null,
} = {}) {
  const db = await getAdapter();
  const count = Math.min(500, Math.max(1, Math.floor(Number(quantity) || 1)));
  const tokens = parseIntOrNull(tokenValue);
  const days = parseIntOrNull(extendsDays);
  if (tokens === null && days === null) {
    throw new Error("A code must carry tokenValue and/or extendsDays");
  }
  const uses = Math.max(1, parseIntOrNull(maxUses) ?? 1);
  const created = [];
  const now = new Date().toISOString();

  for (let i = 0; i < count; i += 1) {
    let code = generateCode();
    // Collision is astronomically unlikely (32^12) but a UNIQUE constraint
    // violation would abort the whole batch, so retry instead of failing.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taken = db.get(`SELECT 1 FROM redeemCodes WHERE code = ?`, [code]);
      if (!taken) break;
      code = generateCode();
    }
    const row = {
      id: randomUUID(),
      code,
      batchName: batchName || null,
      tokenValue: tokens,
      extendsDays: days,
      maxUses: uses,
      usedCount: 0,
      isActive: true,
      createdAt: now,
      expiresAt: expiresAt || null,
      metadata: metadata === null || metadata === undefined ? null : String(metadata),
    };
    db.run(
      `INSERT INTO redeemCodes(
        id, code, batchName, tokenValue, extendsDays, maxUses, usedCount, isActive, createdAt, expiresAt, metadata
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.code, row.batchName, row.tokenValue, row.extendsDays,
        row.maxUses, 0, 1, row.createdAt, row.expiresAt, row.metadata,
      ]
    );
    created.push(row);
  }
  return created;
}

export async function getRedeemCodes({ batchName = null, includeRevoked = true } = {}) {
  const db = await getAdapter();
  const where = [];
  const args = [];
  if (batchName) {
    where.push("batchName = ?");
    args.push(batchName);
  }
  if (!includeRevoked) where.push("isActive = 1");
  const sql = `SELECT * FROM redeemCodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt DESC`;
  return db.all(sql, args).map(rowToCode);
}

export async function getRedeemCodeById(id) {
  const db = await getAdapter();
  return rowToCode(db.get(`SELECT * FROM redeemCodes WHERE id = ?`, [id]));
}

export async function revokeRedeemCode(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM redeemCodes WHERE id = ?`, [id]);
  if (!row) return null;
  db.run(`UPDATE redeemCodes SET isActive = 0 WHERE id = ?`, [id]);
  return rowToCode({ ...row, isActive: 0 });
}

export async function deleteRedeemCode(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM redeemCodes WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

/**
 * Redeem a code against the key doing the redeeming.
 *
 * The code's value is applied to the key row in the same transaction that burns
 * one of the code's uses, so a code can never be spent without the credit
 * landing (and vice versa). Returns a discriminated result rather than
 * throwing, because every failure here is a normal buyer-side outcome.
 */
export async function redeemCode(code, apiKeyInfo) {
  if (!code || typeof code !== "string") return { ok: false, error: "Missing redeem code" };
  if (!apiKeyInfo?.id) return { ok: false, error: "Missing API key" };

  const db = await getAdapter();
  let outcome = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM redeemCodes WHERE code = ?`, [String(code).trim().toUpperCase()]);
    if (!row) {
      outcome = { ok: false, error: "Unknown redeem code" };
      return;
    }
    const entry = rowToCode(row);
    if (!entry.isActive) {
      outcome = { ok: false, error: "Redeem code has been revoked" };
      return;
    }
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= Date.now()) {
      outcome = { ok: false, error: "Redeem code has expired" };
      return;
    }
    if (entry.usedCount >= entry.maxUses) {
      outcome = { ok: false, error: "Redeem code has already been used" };
      return;
    }
    const keyRow = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [apiKeyInfo.id]);
    if (!keyRow) {
      outcome = { ok: false, error: "Unknown API key" };
      return;
    }

    const balanceBefore = parseIntOrNull(keyRow.tokenBalance);
    const balanceAfter = entry.tokenValue === null
      ? balanceBefore
      : (balanceBefore ?? 0) + entry.tokenValue;

    // Expiry extends from "now" when the key is already dead, so a buyer who
    // tops up late still gets the full period they paid for.
    let expiresAt = keyRow.expiresAt || null;
    if (entry.extendsDays !== null) {
      const base = expiresAt && new Date(expiresAt).getTime() > Date.now()
        ? new Date(expiresAt).getTime()
        : Date.now();
      expiresAt = new Date(base + entry.extendsDays * 86400000).toISOString();
    }

    // Note: isActive is deliberately NOT touched. It is the admin's
    // enable/disable switch (a revoked or chargebacked key); a top-up must not
    // resurrect a key that was switched off on purpose. Expiry is re-evaluated
    // from expiresAt on every auth, so pushing expiresAt out is enough to bring
    // a merely expired key back.
    db.run(
      `UPDATE apiKeys SET tokenBalance = ?, expiresAt = ? WHERE id = ?`,
      [balanceAfter, expiresAt, apiKeyInfo.id]
    );
    db.run(
      `UPDATE redeemCodes SET usedCount = usedCount + 1 WHERE id = ?`,
      [entry.id]
    );

    outcome = {
      ok: true,
      code: entry.code,
      creditedTokens: entry.tokenValue ?? 0,
      extendedDays: entry.extendsDays ?? 0,
      tokenBalance: balanceAfter,
      tokensSpent: parseIntOrNull(keyRow.tokensSpent) ?? 0,
      expiresAt,
      usesRemaining: Math.max(0, entry.maxUses - (entry.usedCount + 1)),
    };
  });

  return outcome || { ok: false, error: "Redeem failed" };
}
