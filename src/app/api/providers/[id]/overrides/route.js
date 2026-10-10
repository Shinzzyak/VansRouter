import { NextResponse } from "next/server";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { getProviderConnectionById, getProviderNodeById } from "@/models";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// Per-provider request overrides (9router-go parity: /api/providers/{id}/overrides).
//
// Overrides are stored per provider id in the kv table rather than on the
// connection row: they describe how to TALK to a provider (base URL, headers,
// timeouts, model-name rewrites), which is provider-wide, and an operator with
// ten connections should not have to repeat them ten times.

const overridesKv = makeKv("providerOverrides");

const ALLOWED_KEYS = [
  "baseUrl", "headers", "timeoutMs", "maxRetries", "modelPrefix", "modelSuffix",
  "stripModelPrefix", "extraBody", "userAgent", "proxyUrl", "enabled",
];

function sanitize(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const key of ALLOWED_KEYS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

// GET /api/providers/{id}/overrides
export async function GET(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const overrides = await overridesKv.get(id, {});
    return NextResponse.json({ provider: id, overrides, allowedKeys: ALLOWED_KEYS });
  } catch (error) {
    console.error("GET /api/providers/[id]/overrides failed:", error);
    return NextResponse.json({ error: "Failed to read overrides" }, { status: 500 });
  }
}

// PUT /api/providers/{id}/overrides — merge, or replace when body.replace is true.
export async function PUT(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = await request.json();
    const incoming = sanitize(body?.overrides ?? body);

    const existing = await overridesKv.get(id, {});
    const merged = body?.replace ? incoming : { ...existing, ...incoming };
    await overridesKv.set(id, merged);
    return NextResponse.json({ provider: id, overrides: merged });
  } catch (error) {
    console.error("PUT /api/providers/[id]/overrides failed:", error);
    return NextResponse.json({ error: "Failed to save overrides" }, { status: 500 });
  }
}

// DELETE /api/providers/{id}/overrides — back to provider defaults.
export async function DELETE(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    await overridesKv.remove(id);
    return NextResponse.json({ success: true, provider: id });
  } catch (error) {
    console.error("DELETE /api/providers/[id]/overrides failed:", error);
    return NextResponse.json({ error: "Failed to clear overrides" }, { status: 500 });
  }
}
