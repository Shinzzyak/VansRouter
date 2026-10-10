import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { listModelDeprecations } from "@/lib/db/repos/modelDeprecationsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/models/deprecations?provider=
//
// Keyed by "<provider>/<model>" — the same wire shape as a combo entry — so the
// dashboard can badge a whole model list in one pass.
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const provider = (searchParams.get("provider") || "").trim();
    const deprecations = await listModelDeprecations(provider);
    return NextResponse.json({ provider, deprecations });
  } catch (error) {
    console.log("Error reading model deprecations:", error);
    return NextResponse.json({ error: "Failed to read model deprecations" }, { status: 500 });
  }
}
