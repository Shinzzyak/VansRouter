// Migration 012: separate resell-issued keys from endpoint-managed keys.
//
// One column decides which dashboard surface owns a key:
//   resell  — minted by the resale page's manual mint, or issued when a buyer
//             spends a redeem code on /tukar. These live only in the Resale
//             page; the Endpoint page never lists them.
//   endpoint — every other key (the dashboard's own client keys, bulk imports).
//              NULL (any pre-migration row) maps to endpoint.
//
// Backfill: a key that was issued by spending a code always carries the
// redeemCode marker in its metadata, so those rows are promoted to resell now.
// Manual pre-migration resale mints share the POST /api/keys path with the
// endpoint page and cannot be told apart — they stay endpoint.
export default {
  version: 12,
  name: "add-api-key-source",
  up(db) {
    const rows = db.all("PRAGMA table_info(apiKeys)");
    const columns = Array.isArray(rows) ? rows.map((row) => row.name) : [];
    if (!columns.includes("source")) {
      db.exec("ALTER TABLE apiKeys ADD COLUMN source TEXT");
    }
    db.exec(
      `UPDATE apiKeys SET source = 'resell'
       WHERE source IS NULL AND metadata IS NOT NULL AND metadata LIKE '%redeemCode%'`
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_source ON apiKeys(source)");
  },
};
