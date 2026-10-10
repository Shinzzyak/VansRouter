import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections, reorderProviderConnections } from "@/models";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// POST /api/providers/{id}/reorder — move one connection one slot within its
// provider's pool (9router-go parity: `HandleReorderConnection`, registered on
// both /api/connections/{id}/reorder and /api/providers/{id}/reorder).
//
// Body: {"direction": "up" | "down"}. Anything else is a 400 — silently doing
// nothing on a typo'd direction is how a UI ends up looking broken while the
// API reports success.
//
// The swap and the 1..N renumber run in one transaction (see
// reorderProviderConnections): a two-PUT client swap has no cross-row
// transaction, and a partial failure leaves two rows sharing a priority that a
// stable sort then freezes into a permanent no-op.
export async function POST(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const direction = String(body?.direction ?? "").trim().toLowerCase();
    if (direction !== "up" && direction !== "down") {
      return NextResponse.json({ error: 'direction must be "up" or "down"' }, { status: 400 });
    }

    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const result = await reorderProviderConnections(
      connection.provider,
      id,
      direction === "up" ? -1 : 1,
    );
    if (result?.error === "not_found") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const connections = await getProviderConnections({ provider: connection.provider });
    return NextResponse.json({ status: "ok", id, connections });
  } catch (error) {
    console.error("POST /api/providers/[id]/reorder failed:", error);
    return NextResponse.json({ error: "Failed to reorder provider connections" }, { status: 500 });
  }
}
