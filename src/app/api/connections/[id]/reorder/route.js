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
      // Swap + 1..N renumber in ONE transaction. A per-row priority PUT cannot
      // do this safely: the moved row gets the newest updatedAt, so on a tie it
      // sorts first and a "down" move silently becomes an "up" move.
      const step = body.direction === "up" ? -1 : 1;
      const result = await reorderProviderConnections(connection.provider, id, step);
      if (result?.error === "not_found") {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
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
