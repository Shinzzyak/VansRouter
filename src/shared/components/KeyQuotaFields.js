"use client";

import Input from "./Input";
import { QUOTA_FIELDS } from "@/shared/utils/keyQuota";

// One renderer for the whole quota surface, so the resale page and the key
// editor can never drift apart: both read QUOTA_FIELDS from keyQuota.js.
//
// `value` is the string map keyQuota.js works in ("" = unlimited). `omit` hides
// axes the caller covers elsewhere — the resale page asks the seller for "juta
// token" and maps that onto tokenBalance itself.
export default function KeyQuotaFields({ value = {}, onChange, omit = [], extra = null, columns = 2 }) {
  const fields = QUOTA_FIELDS.filter((f) => !omit.includes(f.key));
  const set = (key, next) => onChange({ ...value, [key]: next });

  return (
    <div className={`grid grid-cols-1 gap-3 ${columns === 2 ? "sm:grid-cols-2" : ""}`}>
      {extra}
      {fields.map((f) => (
        <Input
          key={f.key}
          label={f.label}
          type="number"
          min="0"
          value={value[f.key] ?? ""}
          onChange={(e) => set(f.key, e.target.value)}
          placeholder="kosong = tanpa batas"
          hint={f.hint || undefined}
        />
      ))}
    </div>
  );
}
