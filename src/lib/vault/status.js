// Vault census: how many credential fields are sealed vs still plaintext.
// Counts FIELDS, not rows, because that is the unit the vault actually seals and
// a row can be half-migrated (sealed accessToken, legacy plaintext apiKey).

import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { SECRET_FIELDS, isSealed, vaultEnabled } from "./index.js";

export async function vaultCounts() {
  const db = await getAdapter();
  const rows = db.all(`SELECT id, data FROM providerConnections`);
  let sealed = 0;
  let plaintext = 0;
  for (const row of rows) {
    const data = parseJson(row.data, null);
    if (!data || typeof data !== "object") continue;
    for (const field of SECRET_FIELDS) {
      const value = data[field];
      if (typeof value !== "string" || !value) continue;
      if (isSealed(value)) sealed++;
      else plaintext++;
    }
  }
  return { enabled: vaultEnabled(), sealedCount: sealed, plaintextCount: plaintext, connections: rows.length };
}
