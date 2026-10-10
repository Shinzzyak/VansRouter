import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { freebuffSessionSwitch } from "@/lib/oauth/freebuffSession.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/freebuff/session/switch — move a Freebuff seat to another
// model without waiting for it to expire (9router-go parity).
//
// Body: { connectionId?, model, connection_id? } (snake_case accepted, matching
// the go handler). Deliberate action only: each switch releases the held seat
// and spends a fresh one from the daily allowance.
export async function POST(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json().catch(() => ({}));
    const result = await freebuffSessionSwitch({
      connectionId: body?.connectionId || body?.connection_id || "",
      model: body?.model,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message || "freebuff model switch failed" }, { status: 502 });
  }
}
