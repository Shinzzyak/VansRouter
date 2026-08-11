import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getUsageForProvider, USAGE_PROVIDERS } from "open-sse/services/usage.js";

export const dynamic = "force-dynamic";

const CONCURRENCY = 3;
const PER_CALL_TIMEOUT_MS = 5000;

// Auto-detect: provider yang punya usage handler (USAGE_HANDLERS di usage.js).
// Tambah handler baru → otomatis di-fetch di sini, tanpa edit route ini.
const SUPPORTED = new Set(USAGE_PROVIDERS);

function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (usage.message) return { message: usage.message };
  if (usage.error) return { error: usage.error };

  const quotas = usage.quotas || {};
  const rows = [];
  for (const [key, q] of Object.entries(quotas)) {
    if (!q || typeof q !== "object") continue;
    const total = Number(q.total) || 0;
    const used = Number(q.used) || 0;
    const remaining = Number(q.remaining) ?? Math.max(0, total - used);
    const resetAt = q.resetAt || null;
    const unlimited = !!q.unlimited;
    const row = {
      key,
      total,
      used,
      remaining,
      resetAt,
      unlimited,
    };
    // Pass-through field tambahan per provider (expiring points, dll)
    if (q.expiring) row.expiring = q.expiring;
    rows.push(row);
  }
  const summary = { plan: usage.plan || null, quotas: rows };
  // Pass-through metadata non-quota (sandbox trial, dll)
  if (usage.sandbox) summary.sandbox = usage.sandbox;
  return summary;
}

async function fetchOne(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const connection = await getProviderConnectionById(id);
    if (!connection) return { id, error: "not found" };
    if (!SUPPORTED.has(connection.provider)) return { id, skipped: true };
    const usage = await getUsageForProvider(connection, null);
    return { id, usage: summarizeUsage(usage) };
  } catch (e) {
    return { id, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/account-pool/benefits — batch fetch benefit per akun (concurrency 3)
export async function POST(request) {
  try {
    const body = await request.json();
    const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 100) : [];
    if (!ids.length) return NextResponse.json({ benefits: {} });

    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        results.push(await fetchOne(id));
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));

    const benefits = {};
    for (const r of results) {
      if (r.skipped) continue;
      benefits[r.id] = r.usage || { error: r.error || "unavailable" };
    }
    return NextResponse.json({ benefits });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
