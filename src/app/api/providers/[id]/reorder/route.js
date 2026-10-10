import { NextResponse } from "next/server";
import { reorderProviderConnections } from "@/models";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// POST /api/providers/{id}/reorder — renumber one provider's connections to a
// clean 1..N priority sequence (9router-go parity). Safe to call after deletes.
export async function POST(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    await reorderProviderConnections(id);
    return NextResponse.json({ success: true, provider: id });
  } catch (error) {
    console.error("POST /api/providers/[id]/reorder failed:", error);
    return NextResponse.json({ error: "Failed to reorder provider connections" }, { status: 500 });
  }
}
