import { NextResponse } from "next/server";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// POST /api/connections/{id}/test — probe one connection's credentials
// (9router-go parity).
//
// Delegates to the SAME probe the provider page uses (testSingleConnection), so
// the two surfaces cannot report different verdicts for the same credentials.
// `overrides` lets an operator try candidate credentials without saving them
// first — that is how a broken token is diagnosed before it is written.
export async function POST(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    let overrides = null;
    try {
      const body = await request.json();
      overrides = body?.overrides || null;
    } catch {
      overrides = null;
    }

    const result = await testSingleConnection(id, overrides);
    if (!result) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    return NextResponse.json({ connectionId: id, ...result });
  } catch (error) {
    console.error("POST /api/connections/[id]/test failed:", error);
    return NextResponse.json({ error: "Connection test failed" }, { status: 500 });
  }
}
