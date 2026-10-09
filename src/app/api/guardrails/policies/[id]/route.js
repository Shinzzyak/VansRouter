import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import {
  DETECTOR_SETS,
  GUARDRAIL_ACTIONS,
  SCOPE_ORDER,
  deleteGuardrailPolicyById,
  getGuardrailPolicyById,
  invalidateGuardrailCache,
  updateGuardrailPolicyById,
} from "@/lib/guardrails/index.js";

export const dynamic = "force-dynamic";

/** PUT /api/guardrails/policies/[id] — partial update of one policy. */
export async function PUT(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body?.scope !== undefined && !SCOPE_ORDER.includes(String(body.scope))) {
    return NextResponse.json({ error: `scope must be one of ${SCOPE_ORDER.join(", ")}` }, { status: 400 });
  }
  if (body?.action !== undefined && !Object.values(GUARDRAIL_ACTIONS).includes(String(body.action))) {
    return NextResponse.json({ error: `action must be one of ${Object.values(GUARDRAIL_ACTIONS).join(", ")}` }, { status: 400 });
  }
  if (body?.detectors !== undefined) {
    const known = Object.keys(DETECTOR_SETS);
    if (!Array.isArray(body.detectors) || body.detectors.some((d) => !known.includes(String(d)))) {
      return NextResponse.json({ error: "detectors must be an array of known detector names" }, { status: 400 });
    }
  }

  const updated = await updateGuardrailPolicyById(id, {
    scope: body?.scope === undefined ? undefined : String(body.scope),
    scopeId: body?.scopeId === undefined ? undefined : String(body.scopeId).trim(),
    enabled: body?.enabled === undefined ? undefined : body.enabled ? 1 : 0,
    detectors: body?.detectors === undefined ? undefined : body.detectors.map((d) => String(d)),
    action: body?.action === undefined ? undefined : String(body.action),
  });

  if (!updated) {
    return NextResponse.json({ error: "Policy not found" }, { status: 404 });
  }
  // Moving a row onto a scope another row already owns is a conflict, not a 500:
  // the unique index would otherwise surface as a raw SQLite error.
  if (updated.conflict) {
    return NextResponse.json({ error: "Another policy already covers that scope" }, { status: 409 });
  }

  invalidateGuardrailCache();
  return NextResponse.json({ policy: updated });
}

/** DELETE /api/guardrails/policies/[id] */
export async function DELETE(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const existing = await getGuardrailPolicyById(id);
  if (!existing) {
    return NextResponse.json({ error: "Policy not found" }, { status: 404 });
  }
  await deleteGuardrailPolicyById(id);
  invalidateGuardrailCache();
  return NextResponse.json({ ok: true });
}
