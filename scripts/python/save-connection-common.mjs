// Shared DATA_DIR resolution for all connection-save helpers (autoclawreg,
// tokenharborreg, dll). NEVER falls back to the decommissioned ~/.9router —
// the default is the VansRouter deployment data dir.
//
// IMPORTANT: must be loaded BEFORE the DB layer. ESM static imports evaluate
// src/lib/dataDir.js at import time, so setting process.env.DATA_DIR in the
// helper body is a no-op. Use loadConnectionRepo() (dynamic import) instead.
export const DEFAULT_DATA_DIR = process.env.VANSROUTER_DATA_DIR || "/home/ubuntu/VansRouter/data";

// Resolve DATA_DIR: explicit env wins (validated), otherwise the deployment
// default. Rejects paths that point at the decommissioned ~/.9router DB or a
// double-db path (DATA_DIR ending in /db → $DATA_DIR/db/db/data.sqlite).
export function resolveDataDir() {
  const configured = process.env.DATA_DIR;
  if (configured) {
    const normalized = configured.replace(/\\/g, "/");
    if (normalized.includes(".9router")) {
      throw new Error(
        `[save-connection] DATA_DIR='${configured}' menunjuk ke DB lama ~/.9router yang sudah decommissioned. ` +
          `Hapus env DATA_DIR (default: ${DEFAULT_DATA_DIR}) atau set ke path data yang benar.`
      );
    }
    if (normalized.endsWith("/db")) {
      throw new Error(
        `[save-connection] DATA_DIR='${configured}' berakhir dengan /db — ini menghasilkan path double-db ` +
          `(${configured}/db/data.sqlite). Set DATA_DIR ke root data dir (default: ${DEFAULT_DATA_DIR}).`
      );
    }
    return configured;
  }
  process.env.DATA_DIR = DEFAULT_DATA_DIR;
  return DEFAULT_DATA_DIR;
}

// Dynamic import so DATA_DIR is set before src/lib/dataDir.js evaluates.
export async function loadConnectionRepo() {
  resolveDataDir();
  return await import("../../src/lib/db/repos/connectionsRepo.js");
}
