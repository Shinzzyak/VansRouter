// Guardrail decision log. One row per firing, read by GET /api/guardrails/logs.
//
// Every function here is best-effort by design: an audit write must never turn a
// log_only policy into a block, so a failure is swallowed by the caller rather
// than propagated. See src/lib/guardrails/policies.js.
import { getAdapter } from "../driver.js";

const DEFAULT_LIMIT = 100;
// Bounds the audit page so a query cannot ask for every row ever written.
const MAX_LIMIT = 500;

function rowToLog(row) {
  if (!row) return null;
  let findings = [];
  try {
    const parsed = JSON.parse(row.findings || "[]");
    if (Array.isArray(parsed)) findings = parsed;
  } catch {
    findings = [];
  }
  return {
    id: row.id,
    ts: row.ts,
    apiKeyId: row.apiKeyId || "",
    model: row.model || "",
    detector: row.detector || "unknown",
    direction: row.direction || "inbound",
    action: row.action,
    scope: row.scope || "",
    reason: row.reason || "",
    findings,
    severity: row.severity || "low",
  };
}

/** Clamps a caller-supplied limit into [1, MAX_LIMIT], defaulting to 100. */
export function normalizeLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function insertGuardrailLog(entry) {
  const db = await getAdapter();
  db.run(
    "INSERT INTO guardrailLogs(ts, apiKeyId, model, detector, direction, action, scope, reason, findings, severity) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      entry.ts || new Date().toISOString(),
      entry.apiKeyId || "",
      entry.model || "",
      entry.detector || "unknown",
      entry.direction || "inbound",
      entry.action || "log_only",
      entry.scope || "",
      entry.reason || "",
      JSON.stringify(entry.findings || []),
      entry.severity || "low",
    ]
  );
}

export async function listGuardrailLogs(limit = DEFAULT_LIMIT) {
  const db = await getAdapter();
  return db.all("SELECT * FROM guardrailLogs ORDER BY id DESC LIMIT ?", [normalizeLimit(limit)]).map(rowToLog);
}

export async function countGuardrailLogs() {
  const db = await getAdapter();
  const row = db.get("SELECT COUNT(*) AS n FROM guardrailLogs");
  return row?.n || 0;
}

export async function pruneGuardrailLogs(keep = 5000) {
  const db = await getAdapter();
  db.run("DELETE FROM guardrailLogs WHERE id NOT IN (SELECT id FROM guardrailLogs ORDER BY id DESC LIMIT ?)", [keep]);
  return true;
}
