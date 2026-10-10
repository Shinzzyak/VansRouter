// Master-key rotation: decrypt every sealed field under the current key and
// re-seal it under the next one. Rows that cannot be unwrapped (written under a
// key nobody has any more) are reported and left exactly as they were — a
// rotation must never destroy the rows it cannot read.

import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { SECRET_FIELDS, isSealed, seal, unseal, vaultEnabled } from "./index.js";

export async function rotateVault(nextMasterKey) {
  if (!vaultEnabled()) {
    return { ok: false, error: "Credential vault is disabled. Set ROUTER_MASTER_KEY before rotating." };
  }
  const next = String(nextMasterKey || "").trim();
  if (!next) {
    return { ok: false, error: "nextMasterKey is required" };
  }

  const db = await getAdapter();
  const rows = db.all(`SELECT id, data FROM providerConnections`);
  const rotated = [];
  const skipped = [];
  let sealedFields = 0;

  for (const row of rows) {
    const data = parseJson(row.data, null);
    if (!data || typeof data !== "object") continue;
    const sealedKeys = SECRET_FIELDS.filter((f) => isSealed(data[f]));
    if (!sealedKeys.length) continue;

    const nextData = { ...data };
    const failed = [];
    for (const field of sealedKeys) {
      const plain = unseal(data[field]);
      if (plain === null) {
        failed.push(field);
        continue;
      }
      nextData[field] = seal(plain, next);
      sealedFields++;
    }
    if (failed.length) {
      skipped.push({ id: row.id, fields: failed });
      continue;
    }
    db.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [stringifyJson(nextData), row.id]);
    rotated.push(row.id);
  }

  return { ok: true, rotated, skipped, sealedFields, scanned: rows.length };
}
