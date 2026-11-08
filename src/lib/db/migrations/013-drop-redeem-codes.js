// Migration 013: remove the redeem-code feature (feature kill, 2026-11-08).
//
// Decision context: buyers only ever used the router as "endpoint + API key",
// so the code → redeem → key hop added a page, two APIs and a table for
// nothing. Production data carried zero redeemCodes rows, so dropping the
// table loses nothing. Seller now mints a resell key directly and hands it
// over; the key's quota/validity come from the mint form itself.
//
// The table was created by 010 and extended by 011 — those migrations stay in
// the chain (history is never rewritten), and 013 simply removes the table.
// Nothing else references redeemCodes once the routes, page, and repo are gone.
export default {
  version: 13,
  name: "drop-redeem-codes",
  up(db) {
    db.exec("DROP TABLE IF EXISTS redeemCodes");
    db.exec("DROP INDEX IF EXISTS idx_redeem_code");
  },
};
