import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import {
  DETECTOR_SETS,
  GUARDRAIL_ACTIONS,
  SCOPE_ORDER,
  invalidateGuardrailCache,
  listGuardrailPolicies,
  upsertGuardrailPolicy,
} from "@/lib/guardrails/index.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/guardrails/policies — every configured policy.
 *
 * Also returns the vocabulary the dashboard needs to render the form (scopes,
 * detectors, actions) so the UI never hardcodes a list that the engine could
 * drift away from.
 */
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const policies = await listGuardrailPolicies();
  return NextResponse.json({
    policies,
    scopes: SCOPE_ORDER,
    detectors: Object.keys(DETECTOR_SETS),
    actions: Object.values(GUARDRAIL_ACTIONS),
  });
}

/** POST /api/guardrails/policies — create or replace the policy for one scope. */
export async function POST(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const scope = String(body?.scope || "").trim();
  if (!SCOPE_ORDER.includes(scope)) {
    return NextResponse.json({ error: `scope must be one of ${SCOPE_ORDER.join(", ")}` }, { status: 400 });
  }

  const scopeId = String(body?.scopeId || "").trim();
  // An empty id on a non-global scope is inert by design (see policies.js), so
  // accepting it would write a row that silently never matches.
  if (scope !== "global" && !scopeId) {
    return NextResponse.json({ error: `scope "${scope}" needs a scopeId` }, { status: 400 });
  }

  const detectors = normalizeDetectors(body?.detectors);
  if (detectors === null) {
    return NextResponse.json({ error: "detectors must be an array of known detector names" }, { status: 400 });
  }

  const action = String(body?.action || "log_only").trim();
  if (!Object.values(GUARDRAIL_ACTIONS).includes(action)) {
    return NextResponse.json({ error: `action must be one of ${Object.values(GUARDRAIL_ACTIONS).join(", ")}` }, { status: 400 });
  }

  const policy = await upsertGuardrailPolicy({
    scope,
    scopeId,
    enabled: body?.enabled === undefined ? 1 : body.enabled ? 1 : 0,
    detectors,
    action,
  });
  invalidateGuardrailCache();
  return NextResponse.json({ policy }, { status: 201 });
}

/**
 * Rejects unknown detector names rather than dropping them silently: a typo that
 * stores an empty list would leave a policy row that looks configured and filters
 * nothing.
 */
function normalizeDetectors(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const known = Object.keys(DETECTOR_SETS);
  const out = [];
  for (const name of raw) {
    const s = String(name || "").trim();
    if (!known.includes(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
