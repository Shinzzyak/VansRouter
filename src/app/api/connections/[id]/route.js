import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection, deleteProviderConnection } from "@/models";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// One connection, addressed directly (9router-go parity: /api/connections/{id}).
// Credentials and priority live on the connection row, so these verbs act there
// rather than on the provider.

export async function GET(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    return NextResponse.json({ connection });
  } catch (error) {
    console.error("GET /api/connections/[id] failed:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = await request.json();
    const connection = await updateProviderConnection(id, body);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    return NextResponse.json({ connection });
  } catch (error) {
    console.error("PUT /api/connections/[id] failed:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const deleted = await deleteProviderConnection(id);
    if (!deleted) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/connections/[id] failed:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
