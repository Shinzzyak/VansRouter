import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { buildApiKeyRecord, insertApiKeyRow } from "./apiKeysRepo.js";

// Redeem codes: the only way a buyer gets in.
//
// A seller mints a batch, hands the codes out (sold on a marketplace, pasted
// into a chat, whatever), and the buyer spends one on the public redeem page —
// which issues a fresh API key carrying the code's quota and validity. The code
// *is* the credential, so no key is needed to spend one and a code can never be
// spent onto somebody else's key.
//
// Everything here is admin-side except `redeemCode`, which the public redeem
// endpoint calls.

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
 * Spend a code and issue the key it buys.
 *
 * The burn and the issue happen inside one transaction, in that order of
 * checks: every rejection is decided before anything is written, so a failed
 * redeem leaves the code untouched. Two simultaneous redeems of a single-use
 * code therefore cannot both win — the transaction is synchronous and
 * exclusive, so the second one reads usedCount = maxUses and is refused.
 *
 * Returns a discriminated result rather than throwing: an unknown, revoked,
 * expired or already-spent code is a normal buyer-side outcome, not a fault.
 *
 * @param {string} code the plaintext code
 * @param {{ name?: string|null, ip?: string|null }} context optional labelling
 */
export async function redeemCode(code, { name = null, ip = null } = {}) {
  if (!code || typeof code !== "string") return { ok: false, error: "Missing redeem code" };
  const normalized = code.trim().toUpperCase();

  const db = await getAdapter();
  // Read first so the key record can be built outside the transaction; the row
  // is re-read inside it, which is what actually decides the outcome. Only
  // usedCount and isActive can move between the two reads, and both are
  // re-checked.
  const preview = rowToCode(db.get(`SELECT * FROM redeemCodes WHERE code = ?`, [normalized]));
  if (!preview) return { ok: false, error: "Unknown redeem code" };

  const { getConsistentMachineId } = await import("@/shared/utils/machineId");
  const machineId = await getConsistentMachineId();
  const base = String(name || preview.batchName || "buyer").trim() || "buyer";
  // One code = one key, so the bare name is enough; a multi-use code has to
  // tell its keys apart, and the code suffix plus the use number does it.
  const label =
    preview.maxUses > 1 ? `${base}-${normalized.slice(-4)}-${preview.usedCount + 1}` : base;
  const days = preview.extendsDays;
  const record = await buildApiKeyRecord(label, machineId, {
    // null = unlimited tokens / no expiry: a code may carry one, the other, or both.
    tokenBalance: preview.tokenValue,
    expiresAt: days === null ? null : new Date(Date.now() + days * 86400000).toISOString(),
    personaInject: true,
    metadata: JSON.stringify({
      redeemCode: normalized,
      batch: preview.batchName,
      redeemedFrom: ip || null,
      redeemedAt: new Date().toISOString(),
    }),
  });

  let outcome = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM redeemCodes WHERE code = ?`, [normalized]);
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

    insertApiKeyRow(db, record);
    db.run(`UPDATE redeemCodes SET usedCount = usedCount + 1 WHERE id = ?`, [entry.id]);

    outcome = {
      ok: true,
      code: entry.code,
      tokens: entry.tokenValue,
      days: entry.extendsDays,
      expiresAt: record.expiresAt,
      usesRemaining: Math.max(0, entry.maxUses - (entry.usedCount + 1)),
      key: {
        id: record.id,
        name: record.name,
        key: record.key,
        keyDisplay: record.keyDisplay,
        tokenBalance: record.tokenBalance,
        expiresAt: record.expiresAt,
        isActive: true,
        personaInject: record.personaInject,
      },
    };
  });

  return outcome || { ok: false, error: "Redeem failed" };
}
