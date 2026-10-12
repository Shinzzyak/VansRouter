// Migration 011: a redeem code carries the key's whole policy, not just quota.
//
// `limits` is a JSON blob holding the same axis names an API key row uses
// (rpm, rateLimitTpm, rateLimitConcurrency, maxTokens, maxTokensDaily,
// tokens5h, tokensWeekly, tokensMonthly, tokenBalance, allowedIps,
// personaInject). Nullable: every code minted before this migration keeps
// behaving exactly as it did — tokenValue and extendsDays alone.
//
// Why a blob and not eleven columns: the axis list is owned by
// src/shared/utils/keyQuota.js and enforced by checkApiKeyLimits. Adding an
// axis there must not require a migration, and a code that sets nothing stays
// a row of NULLs rather than a wide table of them.
export default {
  version: 11,
  name: "add-redeem-code-limits",
  up(db) {
    const rows = db.all("PRAGMA table_info(redeemCodes)");
    const columns = Array.isArray(rows) ? rows.map((row) => row.name) : [];
    if (!columns.includes("limits")) {
      db.exec("ALTER TABLE redeemCodes ADD COLUMN limits TEXT");
    }
  },
};
