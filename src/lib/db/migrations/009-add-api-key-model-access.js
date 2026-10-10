// Migration 009: per-API-key model allowlist (9router-go F-7 parity).
// Idempotent — safe to re-run on existing databases.
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 9,
  name: "add-api-key-model-access",
  up(db) {
    const def = TABLES.apiKeyModelAccess;
    db.exec(buildCreateTableSql("apiKeyModelAccess", def));
    for (const idx of def.indexes || []) db.exec(idx);
  },
};
