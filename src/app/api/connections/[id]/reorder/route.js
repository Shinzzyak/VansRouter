import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection, reorderProviderConnections } from "@/models";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// POST /api/connections/{id}/reorder — move one connection in its provider's
// priority order (9router-go parity).
//
// Body { priority } moves this row to an explicit slot and renumbers the rest.
// Body { direction: "up" | "down" } swaps with the neighbour. Omitting both
// renumbers the provider's rows to close gaps left by deletions.
export async function POST(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    if (body?.direction === "up" || body?.direction === "down") {
      const step = body.direction === "up" ? -1 : 1;
      const next = Math.max(1, (connection.priority || 1) + step);
      await updateProviderConnection(id, { priority: next });
    } else if (Number.isFinite(Number(body?.priority))) {
      await updateProviderConnection(id, { priority: Math.max(1, Number(body.priority)) });
    } else {
      await reorderProviderConnections(connection.provider);
    }

    const updated = await getProviderConnectionById(id);
    return NextResponse.json({ connection: updated });
  } catch (error) {
    console.error("POST /api/connections/[id]/reorder failed:", error);
    return NextResponse.json({ error: "Failed to reorder connection" }, { status: 500 });
  }
}
