// Migration 010: resale hardening.
//
// Three additive pieces, all nullable so every key minted before this migration
// keeps exactly the behaviour it had:
//   allowedIps   — JSON array of IPv4 addresses / CIDR blocks the key may be
//                  used from. NULL = any source (today's behaviour).
//   tokenBalance — prepaid lifetime token allowance (the "saldo" a buyer tops
//                  up). NULL = no balance gate.
//   tokensSpent  — lifetime tokens debited against that balance.
// Plus `redeemCodes`: the top-up instrument itself — one row per code, with the
// value it carries (tokens and/or extra days) and its own usage ceiling.
export default {
  version: 10,
  name: "add-api-key-ip-balance-and-redeem",
  up(db) {
    const rows = db.all("PRAGMA table_info(apiKeys)");
    const columns = Array.isArray(rows) ? rows.map((row) => row.name) : [];
    const add = (col, type) => {
      if (!columns.includes(col)) {
        db.exec(`ALTER TABLE apiKeys ADD COLUMN ${col} ${type}`);
      }
    };
    add("allowedIps", "TEXT");      // JSON array of IPv4/CIDR; NULL = any source
    add("tokenBalance", "INTEGER"); // prepaid lifetime tokens; NULL = no gate
    add("tokensSpent", "INTEGER");  // lifetime tokens debited against the balance

    db.exec(`CREATE TABLE IF NOT EXISTS redeemCodes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      batchName TEXT,
      tokenValue INTEGER,
      extendsDays INTEGER,
      maxUses INTEGER DEFAULT 1,
      usedCount INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      expiresAt TEXT,
      metadata TEXT
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_redeem_code ON redeemCodes(code)");
  },
};
